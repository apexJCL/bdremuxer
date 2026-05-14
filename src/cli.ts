#!/usr/bin/env bun
//
// M6: full pipeline for both movies and TV, including extras and a
// resume-from-probe optimization (skip `makemkvcon info` when titles are
// already cached in the DB).

import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";

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

const HELP = `bdremuxer (M6)

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
  --include-extras         remux every non-main / non-episode title that
                           survives the pre-filter into <out>/.../extras/
  --min-length-skip <N>(s|m|h) | false   default: 90s

Paths / behaviour:
  --out DIR                output directory (also where the SQLite DB lives)
  --db PATH                override the SQLite DB path
  --makemkvcon PATH        override the makemkvcon binary
  --dry-run                stop after select, print plan (no remux)
  --force                  re-probe and re-remux even if cached / done

Resume behaviour:
  On re-runs, the probe stage is skipped when title rows are already
  cached in the DB for this disc. Pass --force to drop the cache and
  re-probe. Per-title remux is always skipped when the target MKV file
  already exists unless --force.

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

    // §5.2 Probe — skipped when cached (resume-from-probe). --force drops
    // the cache and re-probes; persistProbe always DELETE+INSERTs.
    let titleRows: TitleRow[];
    const cachedTitles = db
      .query<TitleRow, [number]>(
        `SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`,
      )
      .all(scanRes.disc.id);
    if (cachedTitles.length > 0 && !values.force) {
      titleRows = cachedTitles;
      log(`probe: reusing ${titleRows.length} cached titles (--force to re-probe)`);
    } else {
      log("probe...");
      const { probe } = await runInfo({
        makemkvcon,
        source: `file:${discRoot}`,
        echoStderr: values.verbose,
      });
      titleRows = persistProbe(db, scanRes.disc.id, probe);
      log(`probe: ${titleRows.length} titles persisted`);
    }

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

      // --dry-run: stop after select, print plan only.
      if (values["dry-run"]) {
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

      // §5.6 Remux (TV) + §5.7 Finalize
      const tvRunId = startRun(db, persisted.disc.id);
      try {
        const tvPrinter = makeTvProgressPrinter();
        const remuxResult = await remuxTvEpisodes({
          db,
          outDir: cfg.outDir,
          makemkvcon,
          discRoot,
          disc: persisted.disc,
          show: persisted.show,
          season: persisted.season,
          episodeMap: tvSelection.episodeMap,
          extras: tvSelection.extras,
          runId: tvRunId,
          force: !!values.force,
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
        db,
        disc: discIdentified,
        movie,
        selection,
        source: identified.source,
        dryRun: true,
      });
      return 0;
    }

    // §5.6 Remux + §5.7 Finalize
    const runId = startRun(db, discIdentified.id);

    try {
      const moviePrinter = makeMovieProgressPrinter();
      const remuxResult = await remuxMovieMain({
        db,
        outDir: cfg.outDir,
        makemkvcon,
        discRoot,
        disc: discIdentified,
        movie,
        mainTitle: selection.main,
        extras: selection.extras,
        runId,
        force: !!values.force,
        shortFp,
        onMainProgress: moviePrinter.onMainProgress,
        onExtraProgress: moviePrinter.onExtraProgress,
        onTitleDone: moviePrinter.onTitleDone,
      });

      // Re-read titles so manifest reflects the persisted roles & output_path
      const titlesAfter = db
        .query<TitleRow, [number]>(`SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`)
        .all(discIdentified.id);

      const { manifestPath } = finalize({
        db,
        outDir: cfg.outDir,
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
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

// ---- progress ----------------------------------------------------------

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

// ---- printing -----------------------------------------------------------
//
// All print* functions read stream details from the `track` table rather
// than the live makemkvcon probe output, so they work the same on a fresh
// run and on a resume (where the probe was skipped).

function loadTracks(db: DB, titleId: number): TrackRow[] {
  return db
    .query<TrackRow, [number]>(
      `SELECT * FROM track WHERE title_id = ? ORDER BY id`,
    )
    .all(titleId);
}

function printTitleLine(
  db: DB,
  t: TitleRow,
  indent: string = "  ",
): void {
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
