#!/usr/bin/env bun
//
// M2: scan → probe → classify → identify (movie) → select (main feature).
// No remuxing — prints the proposed plan and stops.

import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";

import { discoverMakemkvcon } from "./makemkv/discover.ts";
import { runInfo } from "./makemkv/cli.ts";
import type { TitleInfo, ProbeResult as RobotProbe } from "./makemkv/robot.ts";
import { CINFO } from "./makemkv/codes.ts";

import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import type { DiscRow, TitleRow } from "./db.ts";

import { scan } from "./pipeline/scan.ts";
import { persistProbe } from "./pipeline/probe.ts";
import { classify, ClassifyError, persistMediaKind } from "./pipeline/classify.ts";
import {
  AmbiguousMatchError,
  identifyMovie,
  persistMovie,
} from "./pipeline/identify/movie.ts";
import { persistMovieSelection, selectMovie } from "./pipeline/select/movie.ts";
import { TmdbClient } from "./metadata/tmdb.ts";

import { formatHms, parseDurationFlag } from "./parse/duration.ts";

const HELP = `bdremuxer (M2)

Usage:
  bdremuxer <BDMV path> [options]

Identification:
  --type movie|tv          override auto-classification (M2 only handles 'movie')
  --title "Name (Year)"    search query hint
  --tmdb-id N              skip search, fetch this TMDB id directly
  --imdb-id ttN            skip search, look up by IMDb id

Selection:
  --include-extras
  --min-length-skip <N>(s|m|h) | false   default: 90s

Paths / behaviour:
  --out DIR                output directory (also where the SQLite DB lives)
  --db PATH                override the SQLite DB path
  --makemkvcon PATH        override the makemkvcon binary
  --force                  re-run from probe even if disc.status='done' (M2: no-op)
  -v, --verbose
  -h, --help

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
        "include-extras": { type: "boolean" },
        "min-length-skip": { type: "string" },
        out: { type: "string" },
        db: { type: "string" },
        makemkvcon: { type: "string" },
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
  log(`makemkvcon: ${makemkvcon}`);
  log(`disc root:  ${discRoot}`);
  log(`db path:    ${cfg.dbPath}`);

  const db = openDb(cfg.dbPath);

  try {
    // §5.1 Scan
    log("scan...");
    const scanRes = await scan(db, discRoot);
    log(`fingerprint: ${scanRes.fingerprint.slice(0, 16)}…`);

    // §5.2 Probe
    log("probe (running makemkvcon info — this can take a while)...");
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
      process.stderr.write(
        "TV box-set support arrives in M4. For now M2 stops here.\n",
      );
      return 1;
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

    // §5.5 Select titles (movie path)
    const selection = selectMovie({
      titles: titleRows,
      minLengthSkipS,
      tmdbRuntimeMin: movie.runtime_min,
      includeExtras: !!values["include-extras"],
    });
    persistMovieSelection(db, discIdentified.id, selection);
    log("selected");

    printPlan({
      disc: discIdentified,
      movie,
      probe,
      selection,
      source: identified.source,
    });
    return 0;
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

// ---- printing -----------------------------------------------------------

type PlanInput = {
  disc: DiscRow;
  movie: {
    tmdb_id: number | null;
    imdb_id: string | null;
    title: string;
    year: number | null;
    runtime_min: number | null;
  };
  probe: RobotProbe;
  selection: ReturnType<typeof selectMovie>;
  source: string;
};

function printPlan(p: PlanInput): void {
  const w = (s: string) => process.stdout.write(s);
  const discName =
    p.probe.disc.get(CINFO.NAME) ??
    p.probe.disc.get(CINFO.VOLUME_NAME) ??
    p.disc.volume_label ??
    "(unknown)";

  w(`Disc: ${discName}\n`);
  w(`  fingerprint: ${p.disc.fingerprint.slice(0, 12)}…\n`);
  w(`  status:      ${p.disc.status}\n`);
  w(`  kind:        ${p.disc.media_kind}\n`);
  w("\n");

  w(`Proposed match  (via ${p.source}):\n`);
  w(
    `  ${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ""}\n`,
  );
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
      const kind = s.get(1) ?? "?"; // SINFO.TYPE
      const lang = s.get(3) ?? "---";
      const codec = s.get(6) ?? s.get(5) ?? "?";
      w(`      ${kind.padEnd(9)} ${lang.padEnd(4)} ${codec}\n`);
    }
  }
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

const exit = await main(Bun.argv.slice(2));
process.exit(exit);
