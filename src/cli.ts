#!/usr/bin/env bun
//
// M4: same as M3 for movies; TV discs go scan → probe → classify →
// identify (TV) → select (TV) → print episode plan. No TV remux yet.

import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";

import { discoverMakemkvcon } from "./makemkv/discover.ts";
import { runInfo } from "./makemkv/cli.ts";
import type { TitleInfo, ProbeResult as RobotProbe } from "./makemkv/robot.ts";
import { CINFO } from "./makemkv/codes.ts";

import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import type { DiscRow, EpisodeOrder, MovieRow, TitleRow } from "./db.ts";

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
import { remuxMovieMain } from "./pipeline/remux.ts";
import { finalize } from "./pipeline/finalize.ts";
import {
  finishRun,
  markDiscFailed,
  startRun,
} from "./pipeline/run.ts";
import { TmdbClient } from "./metadata/tmdb.ts";

import { formatHms, parseDurationFlag } from "./parse/duration.ts";

import { version as PKG_VERSION } from "../package.json";

const HELP = `bdremuxer (M4)

Usage:
  bdremuxer <BDMV path> [options]

Identification (movie):
  --title "Name (Year)"    search query hint
  --tmdb-id N              skip search, fetch this TMDB id directly
  --imdb-id ttN            skip search, look up by IMDb id

Identification (tv):
  --show "Name (Year)"     search query hint for the show
  --tmdb-show-id N         skip show search, fetch this TMDB show id directly
  --season N               season number (required for TV if not parseable from path)
  --starting-episode N     first episode number on this disc (default: 1)
  --episode-order broadcast|production|dvd
                           (M4: only broadcast is implemented; others fall back)

Classification:
  --type movie|tv|auto     default: auto

Selection:
  --include-extras
  --min-length-skip <N>(s|m|h) | false   default: 90s

Paths / behaviour:
  --out DIR                output directory (also where the SQLite DB lives)
  --db PATH                override the SQLite DB path
  --makemkvcon PATH        override the makemkvcon binary
  --dry-run                stop after select, print plan (no remux)
  --force                  re-run remux even if disc.status='done'
  -v, --verbose
  -h, --help

Note: M4 only remuxes movie discs. TV discs stop after the identify/select
plan; TV remux lands in M5.

Environment:
  BDREMUXER_TMDB_API_KEY   required for identification
  BDREMUXER_OUTPUT_DIR, BDREMUXER_DB_PATH, MAKEMKVCON
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        type: { type: "string" },
        title: { type: "string" },
        "tmdb-id": { type: "string" },
        "imdb-id": { type: "string" },
        show: { type: "string" },
        "tmdb-show-id": { type: "string" },
        season: { type: "string" },
        "starting-episode": { type: "string" },
        "episode-order": { type: "string" },
        "include-extras": { type: "boolean" },
        "min-length-skip": { type: "string" },
        out: { type: "string" },
        db: { type: "string" },
        makemkvcon: { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`Expected exactly one BDMV path argument.\n\n${HELP}`);
    return 2;
  }

  const discRoot = normalizeDiscRoot(positionals[0]!);
  const validation = validateBdmv(discRoot);
  if (!validation.ok) {
    process.stderr.write(`${validation.error}\n`);
    return 1;
  }

  const typeFlag = parseTypeFlag(values.type);
  if (typeFlag instanceof Error) {
    process.stderr.write(`${typeFlag.message}\n`);
    return 2;
  }
  let minLengthSkipS: number | null;
  try {
    minLengthSkipS = parseDurationFlag(values["min-length-skip"] ?? "90s");
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const cfg = loadConfig({ outDir: values.out, dbPath: values.db });
  if (!cfg.tmdbApiKey) {
    process.stderr.write(
      "BDREMUXER_TMDB_API_KEY is required for movie identification.\n",
    );
    return 1;
  }

  let makemkvcon: string;
  try {
    makemkvcon = discoverMakemkvcon({ override: values.makemkvcon });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  const log = (msg: string) => {
    if (values.verbose) process.stderr.write(`[bdremuxer] ${msg}\n`);
  };
  log(`bdremuxer v${PKG_VERSION}`);
  log(`makemkvcon: ${makemkvcon}`);
  log(`disc root:  ${discRoot}`);
  log(`out:        ${cfg.outDir}`);
  log(`db:         ${cfg.dbPath}`);

  const db = openDb(cfg.dbPath);

  try {
    // §5.1 Scan
    log("scan...");
    const scanRes = await scan(db, discRoot);
    const shortFp = scanRes.fingerprint.slice(0, 12);
    log(`fingerprint: ${shortFp}…`);

    // Early-out: if a previous run finished cleanly and the user isn't
    // forcing, skip without spawning makemkvcon at all.
    if (!values.force && scanRes.disc.status === "done") {
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

    // §5.2 Probe
    log("probe...");
    const { probe } = await runInfo({
      makemkvcon,
      source: `file:${discRoot}`,
      echoStderr: values.verbose,
    });
    const titleRows = persistProbe(db, scanRes.disc.id, probe);
    log(`probe: ${titleRows.length} titles persisted`);

    // §5.3 Classify
    const parentDirName = basename(dirname(discRoot));
    const kind = (() => {
      try {
        return classify({
          titles: titleRows,
          volumeLabel: scanRes.volumeLabel || null,
          parentDirName,
          minLengthSkipS,
          typeFlag,
        });
      } catch (e) {
        if (e instanceof ClassifyError) {
          process.stderr.write(`${e.message}\n`);
          return null;
        }
        throw e;
      }
    })();
    if (kind === null) return 1;
    const discClassified = persistMediaKind(db, scanRes.disc, kind);
    log(`classified: ${kind}`);

    if (kind === "tv") {
      const episodeOrder = parseEpisodeOrderFlag(values["episode-order"]);
      if (episodeOrder instanceof Error) {
        process.stderr.write(`${episodeOrder.message}\n`);
        return 2;
      }
      const seasonFlag = parseIntFlag(values.season);
      const startingEpisode = parseIntFlag(values["starting-episode"]) ?? 1;

      const tmdb = new TmdbClient({ apiKey: cfg.tmdbApiKey });
      let tvIdentified;
      try {
        tvIdentified = await identifyTv({
          client: tmdb,
          tmdbShowId: parseIntFlag(values["tmdb-show-id"]),
          showHint: values.show,
          seasonFlag,
          episodeOrder,
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
      const persisted = persistTvIdentification(db, discClassified, tvIdentified);
      log(
        `identified: show=tmdb:${tvIdentified.show.id} season=${tvIdentified.season.season_number} ` +
          `(${tvIdentified.effectiveEpisodeOrder} order, season via ${tvIdentified.seasonSource}) ` +
          `episodes=${persisted.episodes.length}`,
      );

      const tvSelection = selectTv({
        titles: titleRows,
        episodes: persisted.episodes,
        minLengthSkipS,
        startingEpisode,
        includeExtras: !!values["include-extras"],
      });
      persistTvSelection(db, persisted.disc.id, tvSelection);
      log(
        `selected: ${tvSelection.episodeMap.length} episodes` +
          (tvSelection.cohort.outlierIncluded ? " (incl. outlier)" : ""),
      );

      printTvPlan({
        disc: persisted.disc,
        show: tvIdentified.show,
        seasonNumber: tvIdentified.season.season_number,
        effectiveEpisodeOrder: tvIdentified.effectiveEpisodeOrder,
        selection: tvSelection,
        source: tvIdentified.source,
        seasonSource: tvIdentified.seasonSource,
        probe,
      });
      return 0;
    }

    // §5.4 Identify (movie)
    log("identify (TMDB)...");
    const client = new TmdbClient({ apiKey: cfg.tmdbApiKey });
    let identified;
    try {
      identified = await identifyMovie({
        client,
        tmdbId: parseIntFlag(values["tmdb-id"]),
        imdbId: values["imdb-id"],
        titleHint: values.title,
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
    const { disc: discIdentified, movie } = persistMovie(
      db,
      discClassified,
      identified.details,
    );
    log(`identified: tmdb=${movie.tmdb_id} imdb=${movie.imdb_id ?? "-"}`);

    // §5.5 Select
    const selection = selectMovie({
      titles: titleRows,
      minLengthSkipS,
      tmdbRuntimeMin: movie.runtime_min,
      includeExtras: !!values["include-extras"],
    });
    persistMovieSelection(db, discIdentified.id, selection);
    log("selected");

    // --dry-run: stop after select, print the plan as M2 did.
    if (values["dry-run"]) {
      printPlan({
        disc: discIdentified,
        movie,
        probe,
        selection,
        source: identified.source,
        dryRun: true,
      });
      return 0;
    }

    // §5.6 Remux + §5.7 Finalize
    const runId = startRun(db, discIdentified.id);

    try {
      const remuxResult = await remuxMovieMain({
        db,
        outDir: cfg.outDir,
        makemkvcon,
        discRoot,
        disc: discIdentified,
        movie,
        mainTitle: selection.main,
        runId,
        force: !!values.force,
        shortFp,
        onProgress: makeProgressPrinter(),
      });
      // newline after the \r-overwritten progress line
      process.stderr.write("\n");

      // Re-read titles so manifest reflects the persisted roles & output_path
      const titlesAfter = db
        .query<TitleRow, [number]>(`SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`)
        .all(discIdentified.id);

      const { manifestPath } = finalize({
        db,
        outDir: cfg.outDir,
        disc: { ...discIdentified, status: "remuxed" },
        movie,
        titles: titlesAfter,
        runId,
        shortFp,
        bdremuxerVersion: PKG_VERSION,
      });

      printDone({
        disc: discIdentified,
        movie,
        outputPath: remuxResult.outputPath,
        manifestPath,
        skipped: remuxResult.skipped,
        logPath: remuxResult.logPath,
      });
      return 0;
    } catch (e) {
      finishRun(db, runId, false);
      markDiscFailed(db, discIdentified.id, "remuxed");
      throw e;
    }
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

// ---- progress ----------------------------------------------------------

function makeProgressPrinter(): (frac: number, task?: string) => void {
  let lastPct = -1;
  let lastTask = "";
  return (frac, task) => {
    const pct = Math.floor(frac * 100);
    if (pct === lastPct && task === lastTask) return;
    lastPct = pct;
    lastTask = task ?? lastTask;
    const bar = renderBar(frac);
    const label = task ? ` ${task}` : "";
    process.stderr.write(`\rRemux: ${bar} ${pct.toString().padStart(3)}%${label}   `);
  };
}

function renderBar(frac: number): string {
  const width = 20;
  const filled = Math.min(width, Math.max(0, Math.floor(frac * width)));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

// ---- printing -----------------------------------------------------------

type PlanInput = {
  disc: DiscRow;
  movie: Pick<MovieRow, "tmdb_id" | "imdb_id" | "title" | "year" | "runtime_min">;
  probe: RobotProbe;
  selection: MovieSelection;
  source: string;
  dryRun: boolean;
};

function printPlan(p: PlanInput): void {
  const w = (s: string) => process.stdout.write(s);
  const discName =
    p.probe.disc.get(CINFO.NAME) ??
    p.probe.disc.get(CINFO.VOLUME_NAME) ??
    p.disc.volume_label ??
    "(unknown)";

  w(`${p.dryRun ? "[dry-run] " : ""}Disc: ${discName}\n`);
  w(`  fingerprint: ${p.disc.fingerprint.slice(0, 12)}…\n`);
  w(`  status:      ${p.disc.status}\n`);
  w(`  kind:        ${p.disc.media_kind}\n`);
  w("\n");

  w(`Proposed match  (via ${p.source}):\n`);
  w(`  ${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ""}\n`);
  w(`  TMDB:  ${p.movie.tmdb_id ?? "-"}\n`);
  w(`  IMDb:  ${p.movie.imdb_id ?? "-"}\n`);
  w(
    `  Runtime: ${p.movie.runtime_min != null ? `${p.movie.runtime_min} min` : "(unknown)"}\n`,
  );
  w("\n");

  w("Main title:\n");
  printTitleLine(p.probe, p.selection.main);

  if (p.selection.extras.length > 0) {
    w(`Extras (${p.selection.extras.length}):\n`);
    for (const t of p.selection.extras) printTitleLine(p.probe, t);
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
  disc: DiscRow;
  show: { id: number; name: string; imdb_id: string | null };
  seasonNumber: number;
  effectiveEpisodeOrder: EpisodeOrder;
  selection: TvSelection;
  source: string;
  seasonSource: "flag" | "parsed";
  probe: RobotProbe;
}): void {
  const w = (s: string) => process.stdout.write(s);
  const discName =
    p.probe.disc.get(CINFO.NAME) ??
    p.probe.disc.get(CINFO.VOLUME_NAME) ??
    p.disc.volume_label ??
    "(unknown)";

  w(`Disc: ${discName}\n`);
  w(`  fingerprint: ${p.disc.fingerprint.slice(0, 12)}…\n`);
  w(`  kind:        tv\n`);
  w(`  status:      ${p.disc.status}\n`);
  w("\n");

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
      "\n",
  );
  w("\n");

  w("Episode mapping:\n");
  for (const { title, episode } of p.selection.episodeMap) {
    const epNumStr = episode.episode_number.toString().padStart(2, "0");
    const seasonStr = p.seasonNumber.toString().padStart(2, "0");
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

  w("\nTV remux lands in M5 — plan only.\n");
}

function printTitleLine(probe: RobotProbe, t: TitleRow): void {
  const w = (s: string) => process.stdout.write(s);
  const info: TitleInfo | undefined = probe.titles.get(t.makemkv_id);
  w(
    `  #${t.makemkv_id.toString().padStart(2, "0")}  ${formatHms(t.duration_s)}  ` +
      `${(t.size_bytes / 1e9).toFixed(2)} GB  segs=${t.segment_map ?? "-"}\n`,
  );
  if (info) {
    for (const sIdx of [...info.streams.keys()].sort((a, b) => a - b)) {
      const s = info.streams.get(sIdx)!;
      const kind = s.get(1) ?? "?";
      const lang = s.get(3) ?? "---";
      const codec = s.get(6) ?? s.get(5) ?? "?";
      w(`      ${kind.padEnd(9)} ${lang.padEnd(4)} ${codec}\n`);
    }
  }
}

function printDone(p: {
  disc: DiscRow;
  movie: Pick<MovieRow, "title" | "year">;
  outputPath: string;
  manifestPath: string;
  skipped: boolean;
  logPath: string;
}): void {
  const w = (s: string) => process.stdout.write(s);
  const verb = p.skipped ? "Already remuxed" : "Remuxed";
  w(`\n${verb}: ${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ""}\n`);
  w(`  Output:   ${p.outputPath}\n`);
  w(`  Manifest: ${p.manifestPath}\n`);
  w(`  Log:      ${p.logPath}\n`);
}

// ---- helpers ------------------------------------------------------------

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

function parseTypeFlag(raw: string | undefined): "movie" | "tv" | undefined | Error {
  if (raw === undefined) return undefined;
  if (raw === "movie" || raw === "tv") return raw;
  if (raw === "auto") return undefined;
  return new Error(`--type must be one of movie|tv|auto (got "${raw}")`);
}

function parseIntFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Expected integer, got "${raw}"`);
  return n;
}

function parseEpisodeOrderFlag(raw: string | undefined): EpisodeOrder | Error {
  if (raw === undefined) return "broadcast";
  if (raw === "broadcast" || raw === "production" || raw === "dvd") return raw;
  return new Error(
    `--episode-order must be one of broadcast|production|dvd (got "${raw}")`,
  );
}

const exit = await main(Bun.argv.slice(2));
process.exit(exit);
