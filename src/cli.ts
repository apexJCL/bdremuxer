#!/usr/bin/env bun
//
// M8: same single-disc flow as M7, plus a `batch <parent-dir>` subcommand
// and a `--output-format=plex|flat` option.

import { Command, InvalidArgumentError, Option } from "commander";
import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  loadBatchOverrides,
  resolveDiscOverrides,
  walkBdmvFolders,
} from "./batch.ts";
import type { CliOpts } from "./opts.ts";

import { discoverMakemkvcon } from "./makemkv/discover.ts";
import { runInfo } from "./makemkv/cli.ts";

import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import type {
  DB,
  DiscRow,
  EpisodeOrder,
  MovieRow,
  TitleRow,
  TrackRow,
} from "./db.ts";

import { scan } from "./pipeline/scan.ts";
import { persistProbe } from "./pipeline/probe.ts";
import { classify, ClassifyError, persistMediaKind } from "./pipeline/classify.ts";
import {
  AmbiguousMatchError,
  identifyMovie,
  persistMovie,
} from "./pipeline/identify/movie.ts";
import {
  AmbiguousTvMatchError,
  identifyTv,
  persistTvIdentification,
} from "./pipeline/identify/tv.ts";
import { persistMovieSelection, selectMovie } from "./pipeline/select/movie.ts";
import type { MovieSelection } from "./pipeline/select/movie.ts";
import { persistTvSelection, selectTv } from "./pipeline/select/tv.ts";
import type { TvSelection } from "./pipeline/select/tv.ts";
import { remuxMovieMain, remuxTvEpisodes } from "./pipeline/remux.ts";
import { finalize } from "./pipeline/finalize.ts";
import {
  finishRun,
  markDiscFailed,
  startRun,
} from "./pipeline/run.ts";
import { TmdbClient } from "./metadata/tmdb.ts";

import { formatHms, parseDurationFlag } from "./parse/duration.ts";

import { version as PKG_VERSION } from "../package.json";

// -----------------------------------------------------------------------
// Argument parsers used by commander
// -----------------------------------------------------------------------

function parseIntArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new InvalidArgumentError(`Expected an integer, got "${value}".`);
  }
  return n;
}

// -----------------------------------------------------------------------
// Commander setup
// -----------------------------------------------------------------------

// All pipeline-affecting flags. Applied to both the root command and the
// `batch` subcommand so users can put flags either before or after the
// subcommand name (commander doesn't inherit options across commands).
function addPipelineOptions(cmd: Command): Command {
  cmd.addOption(
    new Option("--type <kind>", "media-type override (default: auto-detect)")
      .choices(["movie", "tv", "auto"])
      .default("auto"),
  );

  // Movie identification
  cmd.option("--title <name>", 'movie search query hint, e.g. "The Thing (1982)"');
  cmd.option("--tmdb-id <id>", "skip search; fetch this TMDB movie id directly", parseIntArg);
  cmd.option("--imdb-id <id>", "skip search; look up by IMDb id (ttNNNNNNN)");

  // TV identification
  cmd.option("--show <name>", "TV show search query hint");
  cmd.option(
    "--tmdb-show-id <id>",
    "skip show search; fetch this TMDB show id directly",
    parseIntArg,
  );
  cmd.option(
    "--season <n>",
    "season number (required for TV if not parseable from the path)",
    parseIntArg,
  );
  cmd.option(
    "--starting-episode <n>",
    "first episode number on this disc",
    parseIntArg,
    1,
  );
  cmd.addOption(
    new Option(
      "--episode-order <order>",
      "TMDB episode ordering (only 'broadcast' is implemented in v1)",
    )
      .choices(["broadcast", "production", "dvd"])
      .default("broadcast"),
  );

  // Selection
  cmd.option("--include-extras", "remux non-main / non-episode titles into extras/");
  cmd.option(
    "--min-length-skip <duration>",
    'skip titles shorter than this; e.g. "90s", "5m", "1h", or "false"',
    "90s",
  );

  // Paths / behaviour
  cmd.option("--out <dir>", "output directory (also where the SQLite DB lives)");
  cmd.option("--db <path>", "override the SQLite DB path");
  cmd.option("--makemkvcon <path>", "override the makemkvcon binary location");
  cmd.addOption(
    new Option("--output-format <format>", "output layout")
      .choices(["plex", "flat", "jellyfin", "kodi"])
      .default("plex"),
  );
  cmd.option("--dry-run", "stop after select; print plan only (no remux)");
  cmd.option("--force", "re-probe and re-remux even if cached / done");
  cmd.option("-v, --verbose", "extra logging on stderr");

  return cmd;
}

const program = new Command();
program
  .name("bdremuxer")
  .description(
    "Remux a Blu-ray Disc movie or TV box-set into a tidy MKV library, with\n" +
      "TMDB-sourced metadata persisted to a local SQLite database.",
  )
  .version(PKG_VERSION, "--version", "show version and exit")
  .helpOption("-h, --help", "show this help and exit")
  .showHelpAfterError("(run with --help for the full option list)");

addPipelineOptions(program);

program.addHelpText(
  "after",
  `
Resume behaviour:
  On re-runs the probe stage is skipped when title rows are already cached
  in the DB for this disc. Pass --force to drop the cache and re-probe.
  Per-title remux is always skipped when the target MKV file already
  exists unless --force.

Environment:
  BDREMUXER_TMDB_API_KEY   required for identification
  BDREMUXER_OUTPUT_DIR     default for --out
  BDREMUXER_DB_PATH        default for --db
  MAKEMKVCON               default for --makemkvcon

See also:
  bdremuxer batch --help   process a parent directory of BDMV folders`,
);

program
  .argument("<bdmv-path>", "path to a BDMV directory (or its parent)")
  .action(async function rootAction(this: Command, bdmvPath: string) {
    const opts = this.opts<CliOpts>();
    const code = await runPipeline(bdmvPath, opts);
    process.exit(code);
  });

// --- batch subcommand ---------------------------------------------------

const batchCmd = program.command("batch <parent-dir>")
  .description("walk a directory of BDMV folders and process each in sequence");
addPipelineOptions(batchCmd);
batchCmd.option("--continue-on-error", "keep going after a disc fails");
batchCmd.addHelpText(
  "after",
  `
Override resolution (per disc):
  CLI flags → matching glob blocks from <parent-dir>/bdremuxer.batch.toml
            → per-disc sidecar at <parent-dir>/<disc>/bdremuxer.toml

The batch TOML uses subdirectory globs as block keys; the sidecar TOML
uses top-level keys. Both use snake_case versions of the CLI flag names
(e.g. starting_episode = 1).`,
);
batchCmd.action(async function batchAction(this: Command, parentDir: string) {
  const opts = this.opts<CliOpts & { continueOnError?: boolean }>();
  const code = await runBatch(parentDir, opts);
  process.exit(code);
});

await program.parseAsync(process.argv);

// -----------------------------------------------------------------------
// Pipeline runner
// -----------------------------------------------------------------------

async function runPipeline(bdmvArg: string, opts: CliOpts): Promise<number> {
  const discRoot = normalizeDiscRoot(bdmvArg);
  const validation = validateBdmv(discRoot);
  if (!validation.ok) {
    process.stderr.write(`${validation.error}\n`);
    return 1;
  }

  let minLengthSkipS: number | null;
  try {
    minLengthSkipS = parseDurationFlag(opts.minLengthSkip);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const cfg = loadConfig({ outDir: opts.out, dbPath: opts.db });
  if (!cfg.tmdbApiKey) {
    process.stderr.write(
      "BDREMUXER_TMDB_API_KEY is required for identification.\n",
    );
    return 1;
  }

  let makemkvcon: string;
  try {
    makemkvcon = discoverMakemkvcon({ override: opts.makemkvcon });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  const log = (msg: string) => {
    if (opts.verbose) process.stderr.write(`[bdremuxer] ${msg}\n`);
  };
  log(`bdremuxer v${PKG_VERSION}`);
  log(`makemkvcon: ${makemkvcon}`);
  log(`disc root:  ${discRoot}`);
  log(`out:        ${cfg.outDir}`);
  log(`db:         ${cfg.dbPath}`);

  const db = openDb(cfg.dbPath);
  const typeFlag = opts.type === "auto" ? undefined : opts.type;

  try {
    // §5.1 Scan
    log("scan...");
    const scanRes = await scan(db, discRoot);
    const shortFp = scanRes.fingerprint.slice(0, 12);
    log(`fingerprint: ${shortFp}…`);

    // Early-out: if a previous run finished cleanly and the user isn't
    // forcing, skip without spawning makemkvcon at all.
    if (!opts.force && scanRes.disc.status === "done") {
      const existing = db
        .query<{ output_path: string | null }, [number]>(
          `SELECT output_path FROM title WHERE disc_id = ? AND role = 'main'`,
        )
        .get(scanRes.disc.id);
      process.stdout.write(
        `Disc already processed (status=done).\n` +
          (existing?.output_path ? `  Output: ${existing.output_path}\n` : "") +
          `  Pass --force to re-run.\n`,
      );
      return 0;
    }

    // §5.2 Probe — skipped when cached (resume-from-probe).
    let titleRows: TitleRow[];
    const cachedTitles = db
      .query<TitleRow, [number]>(
        `SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`,
      )
      .all(scanRes.disc.id);
    if (cachedTitles.length > 0 && !opts.force) {
      titleRows = cachedTitles;
      log(`probe: reusing ${titleRows.length} cached titles (--force to re-probe)`);
    } else {
      log("probe...");
      const { probe } = await runInfo({
        makemkvcon,
        source: `file:${discRoot}`,
        echoStderr: !!opts.verbose,
      });
      titleRows = persistProbe(db, scanRes.disc.id, probe);
      log(`probe: ${titleRows.length} titles persisted`);
    }

    // §5.3 Classify
    const parentDirName = basename(dirname(discRoot));
    let kind: "movie" | "tv";
    try {
      kind = classify({
        titles: titleRows,
        volumeLabel: scanRes.volumeLabel || null,
        parentDirName,
        minLengthSkipS,
        typeFlag,
      });
    } catch (e) {
      if (e instanceof ClassifyError) {
        process.stderr.write(`${e.message}\n`);
        return 1;
      }
      throw e;
    }
    const discClassified = persistMediaKind(db, scanRes.disc, kind);
    log(`classified: ${kind}`);

    if (kind === "tv") {
      return await runTvPipeline({
        db,
        disc: discClassified,
        titleRows,
        cfg,
        opts,
        scanRes,
        parentDirName,
        makemkvcon,
        discRoot,
        shortFp,
        minLengthSkipS,
        log,
      });
    }
    return await runMoviePipeline({
      db,
      disc: discClassified,
      titleRows,
      cfg,
      opts,
      scanRes,
      parentDirName,
      makemkvcon,
      discRoot,
      shortFp,
      minLengthSkipS,
      log,
    });
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

// -----------------------------------------------------------------------
// Batch orchestrator
// -----------------------------------------------------------------------

async function runBatch(
  parentDir: string,
  opts: CliOpts & { continueOnError?: boolean },
): Promise<number> {
  let parentAbs: string;
  try {
    parentAbs = resolve(parentDir);
    const st = statSync(parentAbs);
    if (!st.isDirectory()) {
      process.stderr.write(`Not a directory: ${parentAbs}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`Path does not exist: ${parentDir}\n`);
    return 1;
  }

  const discs = walkBdmvFolders(parentAbs);
  if (discs.length === 0) {
    process.stderr.write(`No BDMV folders found under ${parentAbs}\n`);
    return 1;
  }

  const batchBlocks = loadBatchOverrides(parentAbs);
  if (opts.verbose) {
    process.stderr.write(
      `[bdremuxer] batch: ${discs.length} discs under ${parentAbs}\n` +
        (batchBlocks.length > 0
          ? `[bdremuxer] batch.toml: ${batchBlocks.length} glob block(s) loaded\n`
          : ""),
    );
  }

  const results: Array<{ relPath: string; code: number }> = [];
  for (let i = 0; i < discs.length; i++) {
    const disc = discs[i]!;
    const effectiveOpts = resolveDiscOverrides({
      cliOpts: opts,
      discRelPath: disc.relPath,
      discAbsPath: disc.absPath,
      batchBlocks,
    });

    process.stderr.write(
      `\n=== Disc ${i + 1}/${discs.length}: ${disc.relPath} ===\n`,
    );
    const code = await runPipeline(disc.absPath, effectiveOpts);
    results.push({ relPath: disc.relPath, code });
    if (code !== 0 && !opts.continueOnError) {
      process.stderr.write(
        `\nDisc failed (exit ${code}); stopping. Pass --continue-on-error to keep going.\n`,
      );
      break;
    }
  }

  const ok = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0);
  process.stderr.write(
    `\n=== Batch summary ===\n  ${ok}/${results.length} disc(s) ok\n`,
  );
  for (const r of failed) {
    process.stderr.write(`  FAILED: ${r.relPath} (exit ${r.code})\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

type StageCtx = {
  db: DB;
  disc: DiscRow;
  titleRows: TitleRow[];
  cfg: ReturnType<typeof loadConfig>;
  opts: CliOpts;
  scanRes: Awaited<ReturnType<typeof scan>>;
  parentDirName: string;
  makemkvcon: string;
  discRoot: string;
  shortFp: string;
  minLengthSkipS: number | null;
  log: (msg: string) => void;
};

async function runMoviePipeline(ctx: StageCtx): Promise<number> {
  const { db, opts, log, cfg, makemkvcon, discRoot, shortFp, titleRows, scanRes, parentDirName, minLengthSkipS } = ctx;

  log("identify (TMDB)...");
  const client = new TmdbClient({ apiKey: cfg.tmdbApiKey! });
  let identified;
  try {
    identified = await identifyMovie({
      client,
      tmdbId: opts.tmdbId,
      imdbId: opts.imdbId,
      titleHint: opts.title,
      volumeLabel: scanRes.volumeLabel,
      parentDirName,
    });
  } catch (e) {
    if (e instanceof AmbiguousMatchError) {
      process.stderr.write(`${e.message}\n\nCandidates:\n`);
      for (const c of e.candidates) {
        const year = c.release_date?.slice(0, 4) ?? "????";
        process.stderr.write(
          `  TMDB:${c.id}  ${c.title} (${year})  pop=${c.popularity.toFixed(1)}\n`,
        );
      }
      return 1;
    }
    throw e;
  }
  const { disc: discIdentified, movie } = persistMovie(db, ctx.disc, identified.details);
  log(`identified: tmdb=${movie.tmdb_id} imdb=${movie.imdb_id ?? "-"}`);

  const selection = selectMovie({
    titles: titleRows,
    minLengthSkipS,
    tmdbRuntimeMin: movie.runtime_min,
    includeExtras: !!opts.includeExtras,
  });
  persistMovieSelection(db, discIdentified.id, selection);
  log("selected");

  if (opts.dryRun) {
    printPlan({
      db,
      disc: discIdentified,
      movie,
      selection,
      source: identified.source,
      dryRun: true,
    });
    return 0;
  }

  const runId = startRun(db, discIdentified.id);
  try {
    const printer = makeMovieProgressPrinter();
    const remuxResult = await remuxMovieMain({
      db,
      outDir: cfg.outDir,
      outputFormat: opts.outputFormat,
      makemkvcon,
      discRoot,
      disc: discIdentified,
      movie,
      mainTitle: selection.main,
      extras: selection.extras,
      runId,
      force: !!opts.force,
      shortFp,
      onMainProgress: printer.onMainProgress,
      onExtraProgress: printer.onExtraProgress,
      onTitleDone: printer.onTitleDone,
    });

    const titlesAfter = db
      .query<TitleRow, [number]>(
        `SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`,
      )
      .all(discIdentified.id);

    const { manifestPath } = finalize({
      db,
      outDir: cfg.outDir,
      outputFormat: opts.outputFormat,
      disc: { ...discIdentified, status: "remuxed" },
      titles: titlesAfter,
      runId,
      shortFp,
      bdremuxerVersion: PKG_VERSION,
      media: { kind: "movie", movie },
    });

    printDone({
      movie,
      main: remuxResult.main,
      extras: remuxResult.extras,
      manifestPath,
      logPath: remuxResult.logPath,
    });
    return 0;
  } catch (e) {
    finishRun(db, runId, false);
    markDiscFailed(db, discIdentified.id, "remuxed");
    throw e;
  }
}

async function runTvPipeline(ctx: StageCtx): Promise<number> {
  const { db, opts, log, cfg, makemkvcon, discRoot, shortFp, titleRows, scanRes, parentDirName, minLengthSkipS } = ctx;

  const tmdb = new TmdbClient({ apiKey: cfg.tmdbApiKey! });
  let tvIdentified;
  try {
    tvIdentified = await identifyTv({
      client: tmdb,
      tmdbShowId: opts.tmdbShowId,
      showHint: opts.show,
      seasonFlag: opts.season,
      episodeOrder: opts.episodeOrder,
      volumeLabel: scanRes.volumeLabel,
      parentDirName,
    });
  } catch (e) {
    if (e instanceof AmbiguousTvMatchError) {
      process.stderr.write(`${e.message}\n\nCandidates:\n`);
      for (const c of e.candidates) {
        const year = c.first_air_date?.slice(0, 4) ?? "????";
        process.stderr.write(
          `  TMDB:${c.id}  ${c.name} (${year})  pop=${c.popularity.toFixed(1)}\n`,
        );
      }
      return 1;
    }
    throw e;
  }
  const persisted = persistTvIdentification(db, ctx.disc, tvIdentified);
  log(
    `identified: show=tmdb:${tvIdentified.show.id} season=${tvIdentified.season.season_number} ` +
      `(${tvIdentified.effectiveEpisodeOrder} order, season via ${tvIdentified.seasonSource}) ` +
      `episodes=${persisted.episodes.length}`,
  );

  const tvSelection = selectTv({
    titles: titleRows,
    episodes: persisted.episodes,
    minLengthSkipS,
    startingEpisode: opts.startingEpisode,
    includeExtras: !!opts.includeExtras,
  });
  persistTvSelection(db, persisted.disc.id, tvSelection);
  log(
    `selected: ${tvSelection.episodeMap.length} episodes` +
      (tvSelection.cohort.outlierIncluded ? " (incl. outlier)" : ""),
  );

  if (opts.dryRun) {
    printTvPlan({
      db,
      disc: persisted.disc,
      show: tvIdentified.show,
      seasonNumber: tvIdentified.season.season_number,
      effectiveEpisodeOrder: tvIdentified.effectiveEpisodeOrder,
      selection: tvSelection,
      source: tvIdentified.source,
      seasonSource: tvIdentified.seasonSource,
      dryRun: true,
    });
    return 0;
  }

  const tvRunId = startRun(db, persisted.disc.id);
  try {
    const tvPrinter = makeTvProgressPrinter();
    const remuxResult = await remuxTvEpisodes({
      db,
      outDir: cfg.outDir,
      outputFormat: opts.outputFormat,
      makemkvcon,
      discRoot,
      disc: persisted.disc,
      show: persisted.show,
      season: persisted.season,
      episodeMap: tvSelection.episodeMap,
      extras: tvSelection.extras,
      runId: tvRunId,
      force: !!opts.force,
      shortFp,
      onEpisodeProgress: tvPrinter.onEpisodeProgress,
      onExtraProgress: tvPrinter.onExtraProgress,
      onTitleDone: tvPrinter.onTitleDone,
    });

    const titlesAfter = db
      .query<TitleRow, [number]>(
        `SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`,
      )
      .all(persisted.disc.id);

    const { manifestPath } = finalize({
      db,
      outDir: cfg.outDir,
      outputFormat: opts.outputFormat,
      disc: { ...persisted.disc, status: "remuxed" },
      titles: titlesAfter,
      runId: tvRunId,
      shortFp,
      bdremuxerVersion: PKG_VERSION,
      media: {
        kind: "tv",
        show: persisted.show,
        season: persisted.season,
        episodes: persisted.episodes,
      },
    });

    printTvDone({
      show: persisted.show,
      seasonNumber: persisted.season.season_number,
      episodes: remuxResult.episodes,
      extras: remuxResult.extras,
      manifestPath,
      logPath: remuxResult.logPath,
    });
    return 0;
  } catch (e) {
    finishRun(db, tvRunId, false);
    markDiscFailed(db, persisted.disc.id, "remuxed");
    throw e;
  }
}

// -----------------------------------------------------------------------
// Progress printers
// -----------------------------------------------------------------------

function makeMovieProgressPrinter(): {
  onMainProgress: (frac: number, task?: string) => void;
  onExtraProgress: (idx: number, total: number, frac: number, task?: string) => void;
  onTitleDone: (kind: "main" | "extra", idx: number, total: number, skipped: boolean) => void;
} {
  let lastKey = "";
  const writeLine = (label: string, frac: number, task?: string) => {
    const pct = Math.floor(frac * 100);
    const key = `${label}-${pct}-${task ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;
    const bar = renderBar(frac);
    const taskLabel = task ? ` ${task}` : "";
    process.stderr.write(`\r${label}: ${bar} ${pct.toString().padStart(3)}%${taskLabel}   `);
  };
  return {
    onMainProgress: (frac, task) => writeLine("Main", frac, task),
    onExtraProgress: (idx, total, frac, task) =>
      writeLine(`Extra ${idx}/${total}`, frac, task),
    onTitleDone: (kind, idx, total, skipped) => {
      const label = kind === "main" ? "Main" : `Extra ${idx}/${total}`;
      if (skipped) process.stderr.write(`\r${label}: already on disk, skipped       \n`);
      else process.stderr.write("\n");
      lastKey = "";
    },
  };
}

function makeTvProgressPrinter(): {
  onEpisodeProgress: (epIdx: number, epTotal: number, frac: number, task?: string) => void;
  onExtraProgress: (idx: number, total: number, frac: number, task?: string) => void;
  onTitleDone: (kind: "episode" | "extra", idx: number, total: number, skipped: boolean) => void;
} {
  let lastKey = "";
  const writeLine = (label: string, frac: number, task?: string) => {
    const pct = Math.floor(frac * 100);
    const key = `${label}-${pct}-${task ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;
    const bar = renderBar(frac);
    const taskLabel = task ? ` ${task}` : "";
    process.stderr.write(`\r${label}: ${bar} ${pct.toString().padStart(3)}%${taskLabel}   `);
  };
  return {
    onEpisodeProgress: (epIdx, epTotal, frac, task) =>
      writeLine(`Ep ${epIdx}/${epTotal}`, frac, task),
    onExtraProgress: (idx, total, frac, task) =>
      writeLine(`Extra ${idx}/${total}`, frac, task),
    onTitleDone: (kind, idx, total, skipped) => {
      const label = kind === "episode" ? `Ep ${idx}/${total}` : `Extra ${idx}/${total}`;
      if (skipped) process.stderr.write(`\r${label}: already on disk, skipped       \n`);
      else process.stderr.write("\n");
      lastKey = "";
    },
  };
}

function renderBar(frac: number): string {
  const width = 20;
  const filled = Math.min(width, Math.max(0, Math.floor(frac * width)));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

// -----------------------------------------------------------------------
// Printing (DB-backed; works on fresh probes and resumed runs)
// -----------------------------------------------------------------------

function loadTracks(db: DB, titleId: number): TrackRow[] {
  return db
    .query<TrackRow, [number]>(
      `SELECT * FROM track WHERE title_id = ? ORDER BY id`,
    )
    .all(titleId);
}

function printTitleLine(db: DB, t: TitleRow, indent: string = "  "): void {
  const w = (s: string) => process.stdout.write(s);
  w(
    `${indent}#${t.makemkv_id.toString().padStart(2, "0")}  ${formatHms(t.duration_s)}  ` +
      `${(t.size_bytes / 1e9).toFixed(2)} GB  segs=${t.segment_map ?? "-"}\n`,
  );
  for (const tr of loadTracks(db, t.id)) {
    w(
      `${indent}    ${tr.kind.padEnd(9)} ${(tr.language ?? "---").padEnd(4)} ${tr.codec ?? "?"}\n`,
    );
  }
}

function printPlan(p: {
  db: DB;
  disc: DiscRow;
  movie: Pick<MovieRow, "tmdb_id" | "imdb_id" | "title" | "year" | "runtime_min">;
  selection: MovieSelection;
  source: string;
  dryRun: boolean;
}): void {
  const w = (s: string) => process.stdout.write(s);

  w(`${p.dryRun ? "[dry-run] " : ""}Disc: ${p.disc.volume_label ?? "(unknown)"}\n`);
  w(`  fingerprint: ${p.disc.fingerprint.slice(0, 12)}…\n`);
  w(`  status:      ${p.disc.status}\n`);
  w(`  kind:        ${p.disc.media_kind}\n\n`);

  w(`Proposed match  (via ${p.source}):\n`);
  w(`  ${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ""}\n`);
  w(`  TMDB:  ${p.movie.tmdb_id ?? "-"}\n`);
  w(`  IMDb:  ${p.movie.imdb_id ?? "-"}\n`);
  w(
    `  Runtime: ${p.movie.runtime_min != null ? `${p.movie.runtime_min} min` : "(unknown)"}\n\n`,
  );

  w("Main title:\n");
  printTitleLine(p.db, p.selection.main);

  if (p.selection.extras.length > 0) {
    w(`Extras (${p.selection.extras.length}):\n`);
    for (const t of p.selection.extras) printTitleLine(p.db, t);
  }

  if (p.selection.skipped.length > 0) {
    w(`Skipped (${p.selection.skipped.length}):\n`);
    for (const { title, reason } of p.selection.skipped) {
      w(
        `  #${title.makemkv_id.toString().padStart(2, "0")}  ${formatHms(title.duration_s)}  ${reason}\n`,
      );
    }
  }

  if (p.dryRun) w("\nDry run — no remux performed.\n");
}

function printTvPlan(p: {
  db: DB;
  disc: DiscRow;
  show: { id: number; name: string; imdb_id: string | null };
  seasonNumber: number;
  effectiveEpisodeOrder: EpisodeOrder;
  selection: TvSelection;
  source: string;
  seasonSource: "flag" | "parsed";
  dryRun?: boolean;
}): void {
  const w = (s: string) => process.stdout.write(s);

  w(`Disc: ${p.disc.volume_label ?? "(unknown)"}\n`);
  w(`  fingerprint: ${p.disc.fingerprint.slice(0, 12)}…\n`);
  w(`  kind:        tv\n`);
  w(`  status:      ${p.disc.status}\n\n`);

  w(`Proposed show  (via ${p.source}):\n`);
  w(`  ${p.show.name}\n`);
  w(`  TMDB:    ${p.show.id}\n`);
  w(`  IMDb:    ${p.show.imdb_id ?? "-"}\n`);
  w(
    `  Season:  ${p.seasonNumber} (${p.effectiveEpisodeOrder} order, source: ${p.seasonSource})\n`,
  );
  w(
    `  Cohort:  ${p.selection.cohort.count} titles, median ${formatHms(p.selection.cohort.median)}` +
      `, relStdev ${(p.selection.cohort.relStdev * 100).toFixed(1)}%` +
      (p.selection.cohort.outlierIncluded
        ? ` (incl. outlier #${p.selection.cohort.outlierIncluded.makemkv_id})`
        : "") +
      "\n\n",
  );

  w("Episode mapping:\n");
  const seasonStr = p.seasonNumber.toString().padStart(2, "0");
  for (const { title, episode } of p.selection.episodeMap) {
    const epNumStr = episode.episode_number.toString().padStart(2, "0");
    const titleStr = title.makemkv_id.toString().padStart(2, "0");
    const epName = episode.name ?? `Episode ${epNumStr}`;
    w(
      `  S${seasonStr}E${epNumStr}  #${titleStr}  ${formatHms(title.duration_s)}  ${epName}\n`,
    );
  }

  if (p.selection.extras.length > 0) {
    w(`\nExtras (${p.selection.extras.length}):\n`);
    for (const t of p.selection.extras) {
      w(
        `  #${t.makemkv_id.toString().padStart(2, "0")}  ${formatHms(t.duration_s)}  ${(t.size_bytes / 1e9).toFixed(2)} GB\n`,
      );
    }
  }

  if (p.selection.skipped.length > 0) {
    w(`\nSkipped (${p.selection.skipped.length}):\n`);
    for (const { title, reason } of p.selection.skipped) {
      w(
        `  #${title.makemkv_id.toString().padStart(2, "0")}  ${formatHms(title.duration_s)}  ${reason}\n`,
      );
    }
  }

  if (p.dryRun) w("\nDry run — no remux performed.\n");
}

function printDone(p: {
  movie: Pick<MovieRow, "title" | "year">;
  main: { outputPath: string; skipped: boolean };
  extras: Array<{ title: TitleRow; outputPath: string; skipped: boolean }>;
  manifestPath: string;
  logPath: string;
}): void {
  const w = (s: string) => process.stdout.write(s);
  const titleStr = `${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ""}`;
  const verb = p.main.skipped ? "Already remuxed" : "Remuxed";
  w(`\n${verb}: ${titleStr}\n`);
  w(`  Main:     ${p.main.outputPath}${p.main.skipped ? " [skipped]" : ""}\n`);
  if (p.extras.length > 0) {
    const skipped = p.extras.filter((e) => e.skipped).length;
    w(`  Extras:   ${p.extras.length - skipped} remuxed${skipped ? `, ${skipped} skipped` : ""}\n`);
    for (const e of p.extras) {
      w(`    ${e.outputPath}${e.skipped ? " [skipped]" : ""}\n`);
    }
  }
  w(`  Manifest: ${p.manifestPath}\n`);
  w(`  Log:      ${p.logPath}\n`);
}

function printTvDone(p: {
  show: { name: string; first_air_year: number | null };
  seasonNumber: number;
  episodes: Array<{
    title: TitleRow;
    episode: { episode_number: number; name: string | null };
    outputPath: string;
    skipped: boolean;
  }>;
  extras: Array<{ title: TitleRow; outputPath: string; skipped: boolean }>;
  manifestPath: string;
  logPath: string;
}): void {
  const w = (s: string) => process.stdout.write(s);
  const seasonStr = p.seasonNumber.toString().padStart(2, "0");
  const yearPart = p.show.first_air_year ? ` (${p.show.first_air_year})` : "";
  const skippedEps = p.episodes.filter((o) => o.skipped).length;
  const remuxedEps = p.episodes.length - skippedEps;

  w(`\n${p.show.name}${yearPart} — Season ${seasonStr}\n`);
  w(`  Episodes: ${remuxedEps} remuxed${skippedEps ? `, ${skippedEps} skipped` : ""}\n`);
  for (const o of p.episodes) {
    const tag = o.skipped ? " [skipped]" : "";
    w(
      `    S${seasonStr}E${o.episode.episode_number.toString().padStart(2, "0")}  ${o.outputPath}${tag}\n`,
    );
  }
  if (p.extras.length > 0) {
    const skippedX = p.extras.filter((e) => e.skipped).length;
    w(`  Extras:   ${p.extras.length - skippedX} remuxed${skippedX ? `, ${skippedX} skipped` : ""}\n`);
    for (const e of p.extras) {
      w(`    ${e.outputPath}${e.skipped ? " [skipped]" : ""}\n`);
    }
  }
  w(`  Manifest: ${p.manifestPath}\n`);
  w(`  Log:      ${p.logPath}\n`);
}

// -----------------------------------------------------------------------
// BDMV path helpers
// -----------------------------------------------------------------------

function normalizeDiscRoot(input: string): string {
  const abs = resolve(input);
  const base = basename(abs);
  if (base === "index.bdmv") return resolve(abs, "..", "..");
  if (base === "BDMV") return resolve(abs, "..");
  return abs;
}

function validateBdmv(discRoot: string): { ok: true } | { ok: false; error: string } {
  try {
    const st = statSync(discRoot);
    if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${discRoot}` };
  } catch {
    return { ok: false, error: `Path does not exist: ${discRoot}` };
  }
  try {
    const st = statSync(join(discRoot, "BDMV", "index.bdmv"));
    if (!st.isFile()) {
      return { ok: false, error: `${discRoot}/BDMV/index.bdmv is not a file` };
    }
  } catch {
    return {
      ok: false,
      error: `No BDMV/index.bdmv under ${discRoot}. Point at the directory that contains the BDMV folder.`,
    };
  }
  return { ok: true };
}
