#!/usr/bin/env bun
//
// M8: same single-disc flow as M7, plus a `batch <parent-dir>` subcommand
// and a `--output-format=plex|flat` option.

import { Command, InvalidArgumentError, Option } from "commander";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  loadBatchOverrides,
  resolveDiscOverrides,
  walkBdmvFolders,
} from "./batch.ts";
import {
  patchStartingEpisodes,
  runInitBatch,
  targetPath as batchTomlTargetPath,
  type StartingEpisodePatch,
} from "./init-batch.ts";
import { Prompter } from "./parse/prompt.ts";
import type { CliOpts } from "./opts.ts";

import { discoverMakemkvcon } from "./makemkv/discover.ts";
import { runInfo } from "./makemkv/cli.ts";

import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import {
  classifyDiscOpenError,
  normalizeBdmvDir,
  openDiscSource,
  type DiscSource,
} from "./disc/index.ts";
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
import type {
  DiscPlan,
  DiscPlanReady,
  MoviePlanData,
  TvPlanData,
} from "./pipeline/plan.ts";
import {
  checkStaleDone,
  countPlans,
  formatIssueReport,
  formatPlanOutcomeShort,
  formatPlanSummary,
} from "./pipeline/plan.ts";
import {
  EpisodeAllocationConflictError,
  findEpisodeAllocationConflicts,
  highestClaimedEpisodeInSeason,
  persistTvSelection,
  selectTv,
} from "./pipeline/select/tv.ts";
import type { TvSelection } from "./pipeline/select/tv.ts";
import { remuxMovieMain, remuxTvEpisodes } from "./pipeline/remux.ts";
import { finalize } from "./pipeline/finalize.ts";
import {
  finishRun,
  markDiscFailed,
  startRun,
} from "./pipeline/run.ts";
import { TmdbClient } from "./metadata/tmdb.ts";
import { OmdbClient } from "./metadata/omdb.ts";

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
// JSON event emission (--json mode)
// -----------------------------------------------------------------------
// Pure NDJSON on stdout. Each line is one event with a `kind` discriminator
// and an ISO timestamp; arbitrary additional fields per event type. Errors
// also flow through here (rather than stderr) so a consumer reading stdout
// gets the full lifecycle.

function emitJson(kind: string, data: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n",
  );
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
  cmd.option("--json", "emit NDJSON events on stdout instead of human-readable text");
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
  .showHelpAfterError("(run with --help for the full option list)")
  // Scope flags strictly to the command that defines them. Without this,
  // when `--force` (or any other shared flag from addPipelineOptions) is
  // typed after a subcommand name, commander attaches it to the root
  // command instead of the subcommand because the option exists on both
  // and the root was registered first. Result: `bdremuxer init-batch
  // --force <dir>` silently fails to honour --force inside the
  // subcommand action.
  .enablePositionalOptions();

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
batchCmd.option(
  "--no-preflight",
  "skip the plan-then-rip pass; process each disc end-to-end as discovered (legacy M8 behaviour)",
);
batchCmd.option(
  "--plan-only",
  "run the preflight pass, print the plan, write the plan file, and exit",
);
batchCmd.option(
  "--confirm-plan",
  "prompt 'Proceed?' after the preflight summary, before the rip phase starts",
);
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
  const opts = this.opts<BatchOpts>();
  const code = await runBatch(parentDir, opts);
  process.exit(code);
});

// --- init-batch subcommand ----------------------------------------------

const initBatchCmd = program
  .command("init-batch <parent-dir>")
  .description(
    "scaffold a bdremuxer.batch.toml — interactive wizard by default,\n" +
      "or --empty for a commented template",
  );
// Share the pipeline option surface (`--verbose`, `--json`, `--out`,
// `--force`, …) so the preflight phase after the wizard sees the same
// flags as `bdremuxer batch`. Without this, flags were silently dropped
// (or rejected by commander) and the user had no way to drive verbose
// progress or to force re-probing during init-batch's preflight pass.
addPipelineOptions(initBatchCmd);
initBatchCmd.option("--empty", "skip the wizard; write a commented template");
initBatchCmd.option(
  "--no-preflight",
  "skip the preflight pass that normally runs after the wizard writes the TOML",
);
initBatchCmd.addHelpText(
  "after",
  `
Note on --force:
  On this subcommand --force has a dual meaning. It overwrites an
  existing bdremuxer.batch.toml (the wizard otherwise refuses), AND it
  flows into the preflight phase so cached probe rows and status='done'
  discs get re-planned. Pass --no-preflight to skip the second half.`,
);
initBatchCmd.action(async function initBatchAction(this: Command, parentDir: string) {
  const sub = this.opts<BatchOpts & { empty?: boolean }>();
  let prompter: Prompter | undefined;
  try {
    prompter = sub.empty ? undefined : new Prompter();
    const res = await runInitBatch({
      parentDir,
      empty: !!sub.empty,
      force: !!sub.force,
      prompter,
    });
    process.stdout.write(`\nWrote ${res.path} (${res.bytes} bytes)\n`);
    if (!sub.empty && res.discCount > 0) {
      process.stdout.write(
        `Reviewed ${res.discCount} disc(s).` +
          ` Edit the file to fine-tune per-disc starting_episode values.\n`,
      );
    }
    // Close the wizard prompter before the preflight pass so stdin
    // isn't held open through the (long-running) probe + TMDB phase.
    prompter?.close();
    prompter = undefined;

    // Preflight after the wizard, with TOML auto-patching: every
    // disc past the first in any season hits the
    // EpisodeAllocationConflict guard, which now carries a structured
    // `fix` we can write back to the TOML in place. If any patches
    // land, we re-run preflight once to verify (one re-run only —
    // anything still blocked is surfaced for manual inspection).
    // Skipped for --empty (no TOML to apply yet) or --no-preflight.
    if (!sub.empty && sub.preflight !== false) {
      // Use the parsed CLI opts as the base; layer in the planOnly +
      // preflight defaults that this code path requires. `as BatchOpts`
      // is safe because addPipelineOptions populates the same fields
      // batchCmd uses (the user just typed the same flags).
      const baseOpts: BatchOpts = {
        ...sub,
        planOnly: true,
        preflight: true,
      } as BatchOpts;
      const code = await runInitBatchPreflightWithAutoPatch(parentDir, baseOpts);
      process.exit(code);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  } finally {
    prompter?.close();
  }
});

await program.parseAsync(process.argv);

// -----------------------------------------------------------------------
// Pipeline runner
// -----------------------------------------------------------------------

async function runPipeline(bdmvArg: string, opts: CliOpts): Promise<number> {
  let minLengthSkipS: number | null;
  try {
    minLengthSkipS = parseDurationFlag(opts.minLengthSkip);
  } catch (e) {
    reportError(opts, (e as Error).message);
    return 2;
  }

  // Default the output dir to a sibling of the input disc — i.e., the
  // parent of the BDMV folder — when the user hasn't pinned one via flag
  // or env. Keeps output co-located with the source library by default.
  // Computed before opening the DiscSource so the ISO backend's mount
  // root can land under <out>/.bdremuxer/mounts (specs/spec-iso.md §4.1).
  const cfg = loadConfig({
    outDir: opts.out,
    dbPath: opts.db,
    defaultOutDir: defaultLibraryDir(bdmvArg),
  });
  if (!cfg.tmdbApiKey) {
    reportError(opts, "BDREMUXER_TMDB_API_KEY is required for identification.");
    return 1;
  }

  let makemkvcon: string;
  try {
    makemkvcon = discoverMakemkvcon({ override: opts.makemkvcon });
  } catch (e) {
    reportError(opts, (e as Error).message);
    return 1;
  }

  const log = (msg: string) => {
    if (opts.verbose) process.stderr.write(`[bdremuxer] ${msg}\n`);
  };
  log(`bdremuxer v${PKG_VERSION}`);
  log(`makemkvcon: ${makemkvcon}`);

  let source: DiscSource;
  try {
    source = await openDiscSource(bdmvArg, {
      mountRoot: join(tmpdir(), "bdremuxer-mounts"),
      log,
      emitEvent: opts.json ? emitJson : undefined,
    });
  } catch (e) {
    reportError(opts, formatDiscOpenError(e));
    return 1;
  }

  const discRoot = source.bdmvPath;
  log(`disc root:  ${discRoot}`);
  log(`out:        ${cfg.outDir}`);
  log(`db:         ${cfg.dbPath}`);

  const db = openDb(cfg.dbPath);
  const typeFlag = opts.type === "auto" ? undefined : opts.type;

  try {
    // §5.1 Scan
    log("scan...");
    const scanRes = await scan(db, source);
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
      if (opts.json) {
        emitJson("already_done", {
          fingerprint: scanRes.fingerprint,
          output_path: existing?.output_path ?? null,
        });
      } else {
        process.stdout.write(
          `Disc already processed (status=done).\n` +
            (existing?.output_path ? `  Output: ${existing.output_path}\n` : "") +
            `  Pass --force to re-run.\n`,
        );
      }
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
    const parentDirName = basename(dirname(source.originalPath));
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
        reportError(opts, e.message, "classify");
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
        source,
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
      source,
      discRoot,
      shortFp,
      minLengthSkipS,
      log,
    });
  } catch (e) {
    reportError(opts, (e as Error).message);
    return 1;
  } finally {
    db.close();
    try {
      await source.close();
    } catch {}
  }
}

function reportError(
  opts: { json?: boolean },
  message: string,
  stage?: string,
): void {
  if (opts.json) emitJson("error", { message, stage: stage ?? null });
  else process.stderr.write(`${message}\n`);
}

// -----------------------------------------------------------------------
// Batch orchestrator
// -----------------------------------------------------------------------

type BatchOpts = CliOpts & {
  continueOnError?: boolean;
  preflight?: boolean; // commander negates --no-preflight to preflight=false
  planOnly?: boolean;
  confirmPlan?: boolean;
};

// init-batch flavour of preflight: same phase-1 pass `batch` would run,
// but after it lands we collect any structured `fix` values from blocked
// discs (today: starting_episode suggestions from the
// EpisodeAllocationConflict guard) and patch them into the just-written
// bdremuxer.batch.toml. One re-run validates the patch; anything still
// blocked after that is surfaced to the user verbatim.
async function runInitBatchPreflightWithAutoPatch(
  parentDir: string,
  baseOpts: BatchOpts,
): Promise<number> {
  let parentAbs: string;
  try {
    parentAbs = resolve(parentDir);
    const st = statSync(parentAbs);
    if (!st.isDirectory()) {
      reportError(baseOpts, `Not a directory: ${parentAbs}`);
      return 1;
    }
  } catch {
    reportError(baseOpts, `Path does not exist: ${parentDir}`);
    return 1;
  }

  const discs = walkBdmvFolders(parentAbs);
  if (discs.length === 0) {
    reportError(baseOpts, `No BDMV folders found under ${parentAbs}`);
    return 1;
  }

  // First pass.
  const batchBlocks1 = loadBatchOverrides(parentAbs);
  const opts1: BatchOpts = {
    ...baseOpts,
    out: baseOpts.out ?? process.env["BDREMUXER_OUTPUT_DIR"] ?? parentAbs,
  };
  process.stdout.write(`\n[bdremuxer] running preflight pass…\n`);
  if (opts1.force) {
    // Visible acknowledgement so the user knows the flag was honoured —
    // its observable effect during planning (skipping the already-done
    // shortcut + ignoring cached probe rows) only matters on re-runs
    // and is otherwise invisible.
    process.stdout.write(
      `[bdremuxer] --force enabled: re-probing cached titles and re-planning status='done' discs\n`,
    );
  }
  const first = await runPreflightPass(parentAbs, discs, batchBlocks1, opts1);

  // Gather every blocked disc that carries a structured fix.
  const patches: StartingEpisodePatch[] = [];
  for (const p of first.plans) {
    if (p.kind === "blocked" && p.fix?.kind === "set-starting-episode") {
      patches.push({ relPath: p.relPath, startingEpisode: p.fix.value });
    }
  }
  if (patches.length === 0) {
    // Nothing actionable — exit honestly.
    return first.counts.blocked > 0 || first.counts.staleDone > 0 ? 1 : 0;
  }

  const tomlPath = batchTomlTargetPath(parentAbs);
  const result = patchStartingEpisodes(tomlPath, patches);
  process.stdout.write(
    `\n[bdremuxer] auto-patched ${result.patched.length} starting_episode value(s) in ${tomlPath}:\n`,
  );
  for (const p of patches) {
    const ok = result.patched.includes(p.relPath);
    process.stdout.write(
      `  ${ok ? "✓" : "·"} ${p.relPath} → starting_episode = ${p.startingEpisode}` +
        (ok ? "" : "  (block not found / no starting_episode key)") +
        "\n",
    );
  }
  if (result.patched.length === 0) {
    // Nothing actually landed; don't bother re-running.
    return 1;
  }

  // Re-run preflight against the patched TOML so the user sees a clean
  // summary (or a smaller, more specific issue list).
  process.stdout.write(`\n[bdremuxer] re-running preflight to verify the patches…\n`);
  const batchBlocks2 = loadBatchOverrides(parentAbs);
  const second = await runPreflightPass(parentAbs, discs, batchBlocks2, opts1);
  return second.counts.blocked > 0 || second.counts.staleDone > 0 ? 1 : 0;
}

async function runBatch(parentDir: string, opts: BatchOpts): Promise<number> {
  let parentAbs: string;
  try {
    parentAbs = resolve(parentDir);
    const st = statSync(parentAbs);
    if (!st.isDirectory()) {
      reportError(opts, `Not a directory: ${parentAbs}`);
      return 1;
    }
  } catch {
    reportError(opts, `Path does not exist: ${parentDir}`);
    return 1;
  }

  const discs = walkBdmvFolders(parentAbs);
  if (discs.length === 0) {
    reportError(opts, `No BDMV folders found under ${parentAbs}`);
    return 1;
  }

  const batchBlocks = loadBatchOverrides(parentAbs);
  const batchDefaultedOpts: BatchOpts = {
    ...opts,
    out: opts.out ?? process.env["BDREMUXER_OUTPUT_DIR"] ?? parentAbs,
  };

  if (opts.json) {
    emitJson("batch_start", {
      parent_dir: parentAbs,
      disc_count: discs.length,
      batch_toml_blocks: batchBlocks.length,
      out_dir: batchDefaultedOpts.out,
      preflight: opts.preflight !== false,
    });
  } else if (opts.verbose) {
    process.stderr.write(
      `[bdremuxer] batch: ${discs.length} discs under ${parentAbs}\n` +
        `[bdremuxer] batch out:  ${batchDefaultedOpts.out}\n` +
        (batchBlocks.length > 0
          ? `[bdremuxer] batch.toml: ${batchBlocks.length} glob block(s) loaded\n`
          : ""),
    );
  }

  // commander treats --no-preflight as preflight=false; default is undefined
  // → treated as true.
  const preflightEnabled = opts.preflight !== false;
  if (!preflightEnabled) {
    return await runBatchLegacy(parentAbs, discs, batchBlocks, batchDefaultedOpts);
  }
  return await runBatchWithPreflight(parentAbs, discs, batchBlocks, batchDefaultedOpts);
}

// Legacy M8 flow: per-disc plan+execute end-to-end as we walk. Used when
// the user passes --no-preflight.
async function runBatchLegacy(
  parentAbs: string,
  discs: ReturnType<typeof walkBdmvFolders>,
  batchBlocks: ReturnType<typeof loadBatchOverrides>,
  batchDefaultedOpts: BatchOpts,
): Promise<number> {
  const results: Array<{ relPath: string; code: number }> = [];
  for (let i = 0; i < discs.length; i++) {
    const disc = discs[i]!;
    const effectiveOpts = resolveDiscOverrides({
      cliOpts: batchDefaultedOpts,
      discRelPath: disc.relPath,
      discAbsPath: disc.absPath,
      batchBlocks,
    });

    if (batchDefaultedOpts.json) {
      emitJson("batch_disc_start", { idx: i + 1, total: discs.length, rel_path: disc.relPath });
    } else {
      process.stderr.write(`\n=== Disc ${i + 1}/${discs.length}: ${disc.relPath} ===\n`);
    }
    const code = await runPipeline(disc.absPath, effectiveOpts);
    results.push({ relPath: disc.relPath, code });
    if (code !== 0 && !batchDefaultedOpts.continueOnError) {
      if (!batchDefaultedOpts.json) {
        process.stderr.write(
          `\nDisc failed (exit ${code}); stopping. Pass --continue-on-error to keep going.\n`,
        );
      }
      break;
    }
  }
  return finalizeBatchResults(results, batchDefaultedOpts);
}

// Two-phase flow: plan every disc first, surface every issue at once, then
// rip the ready discs in walk order. See spec-preflight.md.
// Phase 1 only: walk every disc, plan it, print the summary, write the
// plan file. Used by both the batch flow (which then proceeds to phase 2)
// and the init-batch handler (which uses the plans to auto-patch the
// freshly-written TOML before re-running this same pass to verify).
export async function runPreflightPass(
  parentAbs: string,
  discs: ReturnType<typeof walkBdmvFolders>,
  batchBlocks: ReturnType<typeof loadBatchOverrides>,
  batchDefaultedOpts: BatchOpts,
): Promise<{
  plans: DiscPlan[];
  counts: ReturnType<typeof countPlans>;
  perDiscOpts: CliOpts[];
}> {
  const perDiscOpts = discs.map((d) =>
    resolveDiscOverrides({
      cliOpts: batchDefaultedOpts,
      discRelPath: d.relPath,
      discAbsPath: d.absPath,
      batchBlocks,
    }),
  );

  if (!batchDefaultedOpts.json) {
    process.stderr.write(`\n[plan] Walking ${discs.length} disc(s)…\n`);
  } else {
    emitJson("preflight_start", { parent_dir: parentAbs, total_discs: discs.length });
  }
  // Render the live per-disc line only when the user is reading text on
  // stdout/stderr — under --json the structured preflight_disc_planned
  // events already cover it, and the rewriting cursor would corrupt the
  // NDJSON stream of any consumer that's also reading stderr.
  const useProgress = !batchDefaultedOpts.json;
  const plans: DiscPlan[] = [];
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i]!;
    const dOpts = perDiscOpts[i]!;
    const progress = useProgress
      ? startDiscProgress({
          idx: i + 1,
          total: discs.length,
          relPath: d.relPath,
          out: process.stderr,
        })
      : undefined;
    let plan: DiscPlan;
    try {
      plan = await planSingleDisc(d.absPath, dOpts, d.relPath, progress);
    } catch (e) {
      progress?.done(`⚠ unexpected error: ${(e as Error).message.slice(0, 80)}`);
      throw e;
    }
    progress?.done(formatPlanOutcomeShort(plan));
    plans.push(plan);
    if (batchDefaultedOpts.json) {
      emitJson("preflight_disc_planned", {
        idx: i + 1,
        total: discs.length,
        rel_path: d.relPath,
        status: plan.kind,
        ...(plan.kind === "blocked"
          ? { stage: plan.stage, reason: plan.reason, suggestion: plan.suggestion ?? null }
          : {}),
        ...(plan.kind === "stale-done" ? { missing: plan.missingOutputs } : {}),
      });
    }
  }

  const counts = countPlans(plans);
  if (!batchDefaultedOpts.json) {
    process.stdout.write(formatPlanSummary(plans, parentAbs));
    const issues = formatIssueReport(plans);
    if (issues) process.stdout.write(issues);
  } else {
    emitJson("preflight_summary", {
      ready: counts.ready,
      blocked: counts.blocked,
      already_done: counts.alreadyDone,
      stale_done: counts.staleDone,
      total: counts.total,
    });
  }

  try {
    const planPath = writeBatchPlanFile(plans, parentAbs, batchDefaultedOpts.out ?? parentAbs);
    if (batchDefaultedOpts.verbose && !batchDefaultedOpts.json) {
      process.stderr.write(`[bdremuxer] plan file: ${planPath}\n`);
    }
  } catch (e) {
    if (batchDefaultedOpts.verbose) {
      process.stderr.write(`[bdremuxer] warning: failed to write plan file: ${(e as Error).message}\n`);
    }
  }

  return { plans, counts, perDiscOpts };
}

async function runBatchWithPreflight(
  parentAbs: string,
  discs: ReturnType<typeof walkBdmvFolders>,
  batchBlocks: ReturnType<typeof loadBatchOverrides>,
  batchDefaultedOpts: BatchOpts,
): Promise<number> {
  const { plans, counts, perDiscOpts } = await runPreflightPass(
    parentAbs,
    discs,
    batchBlocks,
    batchDefaultedOpts,
  );

  if (batchDefaultedOpts.planOnly) {
    // Non-zero only if something needs attention.
    return counts.blocked > 0 || counts.staleDone > 0 ? 1 : 0;
  }

  if (batchDefaultedOpts.confirmPlan && counts.ready > 0) {
    const prompter = new Prompter();
    try {
      const proceed = await prompter.askBool(
        `\nProceed with ripping ${counts.ready} disc(s)?`,
        true,
      );
      if (!proceed) {
        process.stderr.write("Aborted before rip phase. The plan file is on disk.\n");
        return 0;
      }
    } finally {
      prompter.close();
    }
  }

  if (counts.ready === 0) {
    // Nothing to do in phase 2. Exit non-zero if there's anything to fix.
    return counts.blocked > 0 || counts.staleDone > 0 ? 1 : 0;
  }

  // Phase 2: execute the ready plans.
  const results: Array<{ relPath: string; code: number }> = [];
  let readyIdx = 0;
  const readyTotal = counts.ready;
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    if (plan.kind !== "ready") continue;
    readyIdx++;
    const dOpts = perDiscOpts[i]!;
    if (batchDefaultedOpts.json) {
      emitJson("batch_disc_start", {
        idx: readyIdx,
        total: readyTotal,
        rel_path: plan.relPath,
      });
    } else {
      process.stderr.write(
        `\n=== Rip ${readyIdx}/${readyTotal}: ${plan.relPath} ===\n`,
      );
    }
    const code = await executePlannedDisc(plan, dOpts);
    results.push({ relPath: plan.relPath, code });
    if (code !== 0 && !batchDefaultedOpts.continueOnError) {
      if (!batchDefaultedOpts.json) {
        process.stderr.write(
          `\nDisc failed (exit ${code}); stopping. Pass --continue-on-error to keep going.\n`,
        );
      }
      break;
    }
  }
  const code = finalizeBatchResults(results, batchDefaultedOpts);
  // Surface the planning issues in the final exit code too.
  return code !== 0 || counts.blocked > 0 || counts.staleDone > 0 ? 1 : 0;
}

function finalizeBatchResults(
  results: Array<{ relPath: string; code: number }>,
  opts: BatchOpts,
): number {
  const ok = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0);
  if (opts.json) {
    emitJson("batch_summary", {
      ok,
      total: results.length,
      failed: failed.map((r) => ({ rel_path: r.relPath, code: r.code })),
    });
  } else {
    process.stderr.write(
      `\n=== Batch summary ===\n  ${ok}/${results.length} disc(s) ok\n`,
    );
    for (const r of failed) {
      process.stderr.write(`  FAILED: ${r.relPath} (exit ${r.code})\n`);
    }
  }
  return failed.length > 0 ? 1 : 0;
}

// Best-effort plan file. Informational only (the DB is source of truth for
// resume). One file per batch, keyed by a short hash of (parent_dir + disc
// rel paths) so re-runs overwrite the same file.
function writeBatchPlanFile(plans: DiscPlan[], parentDir: string, outDir: string): string {
  const fp = createHash("sha256")
    .update(parentDir + "\n")
    .update(plans.map((p) => p.relPath).join("\n"))
    .digest("hex")
    .slice(0, 12);
  const dir = join(outDir, ".bdremuxer", "plans");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fp}.json`);
  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    bdremuxer_version: PKG_VERSION,
    parent_dir: parentDir,
    out_dir: outDir,
    plans: plans.map(serializePlan),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

function serializePlan(p: DiscPlan): Record<string, unknown> {
  const base = { rel_path: p.relPath, abs_path: p.absPath, status: p.kind };
  switch (p.kind) {
    case "ready": {
      if (p.media.kind === "movie") {
        return {
          ...base,
          short_fp: p.shortFp,
          media: {
            kind: "movie",
            tmdb_id: p.media.movie.tmdb_id,
            imdb_id: p.media.movie.imdb_id,
            title: p.media.movie.title,
            year: p.media.movie.year,
            extras: p.media.selection.extras.length,
            identify_source: p.media.identifySource,
          },
        };
      }
      return {
        ...base,
        short_fp: p.shortFp,
        media: {
          kind: "tv",
          tmdb_show_id: p.media.show.tmdb_id,
          name: p.media.show.name,
          season_number: p.media.season.season_number,
          episode_count: p.media.selection.episodeMap.length,
          first_episode_number: p.media.selection.episodeMap[0]?.episode.episode_number ?? null,
          last_episode_number:
            p.media.selection.episodeMap[p.media.selection.episodeMap.length - 1]?.episode
              .episode_number ?? null,
          extras: p.media.selection.extras.length,
          identify_source: p.media.identifySource,
          season_source: p.media.seasonSource,
        },
      };
    }
    case "blocked":
      return { ...base, stage: p.stage, reason: p.reason, suggestion: p.suggestion ?? null };
    case "already-done":
      return { ...base, output_path: p.outputPath };
    case "stale-done":
      return { ...base, missing_outputs: p.missingOutputs };
  }
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
  /** Held by the orchestrator for the lifetime of the pipeline. */
  source: DiscSource;
  /**
   * Equals `source.bdmvPath` — the path passed to `makemkvcon file:…`
   * and used wherever pipeline code needs to read disc bytes. Kept as
   * a separate field so the inner stages don't need to dereference
   * `source` on every read.
   */
  discRoot: string;
  shortFp: string;
  minLengthSkipS: number | null;
  log: (msg: string) => void;
};

// -------- Per-disc planning (phase 1 of preflight) -----------------------
//
// Run scan/probe/classify/identify/select for one disc, persist everything
// that's safe to persist, and return a DiscPlan describing the outcome.
// Owns its own DB connection. Used by both the preflight pass and the
// single-disc invocation flow below.

// A progress sink the preflight loop uses to render a live per-disc
// status line. planSingleDisc just calls `setStage(name)` at each stage
// boundary; the renderer (see `startDiscProgress` below) decides whether
// to rewrite in place on a TTY, print line-per-stage on a non-TTY, or
// stay silent under --json.
//
// `log(msg)` is the verbose-mode escape hatch: it lets planSingleDisc
// emit a diagnostic line that sits *above* the live status line without
// corrupting the in-place cursor. The TTY renderer clears the live
// line, writes the log message + newline, then redraws the live line
// underneath. Without this, `--verbose` would be silently disabled
// whenever a progress sink is active.
type PlanProgressSink = {
  setStage: (stage: string) => void;
  log: (msg: string) => void;
};

// Builds a PlanProgressSink that renders one line per disc:
//
//   TTY mode: `  [3/6] DISC.iso · probing… 47s` rewritten in place,
//     elapsed-time ticker refreshes every second so a stalled stage is
//     visibly stalled. `done()` rewrites the line one last time with
//     the final outcome and emits a newline so the next disc starts
//     fresh.
//   Non-TTY mode: one line per stage transition (linear log), same
//     content. Used in CI / piped output where `\r` is meaningless.
//
// Time is per-stage, not per-disc: when the user sees `identifying…
// 60s` they know TMDB has been hanging for a minute, not that the disc
// has taken a minute total. That's the actionable signal for "stuck".
function startDiscProgress(opts: {
  idx: number;
  total: number;
  relPath: string;
  out: NodeJS.WriteStream;
}): PlanProgressSink & { done: (outcome: string) => void } {
  const { idx, total, relPath, out } = opts;
  const isTty = !!out.isTTY;
  let stage = "preparing";
  let stageStart = Date.now();

  const live = () => {
    const elapsed = Math.round((Date.now() - stageStart) / 1000);
    if (isTty) {
      // \r returns to column 0; \x1b[2K clears the whole line.
      // Clamp to terminal width so a long relPath doesn't wrap — once
      // the line wraps, \r returns to the start of the LAST wrapped
      // row, and the next tick's \x1b[2K only clears that row, leaving
      // upper wrap rows on screen as ghost text.
      const raw = `  [${idx}/${total}] ${relPath} · ${stage}… ${elapsed}s`;
      const cols = out.columns ?? 0;
      const line =
        cols > 4 && raw.length >= cols ? `${raw.slice(0, cols - 2)}…` : raw;
      out.write(`\r\x1b[2K${line}`);
    }
  };

  const interval = isTty ? setInterval(live, 1000) : null;
  live();

  return {
    setStage(next: string) {
      const elapsed = Math.round((Date.now() - stageStart) / 1000);
      if (!isTty) {
        out.write(`  [${idx}/${total}] ${relPath} · ${stage} → ${next} (${elapsed}s in ${stage})\n`);
      }
      stage = next;
      stageStart = Date.now();
      live();
    },
    log(msg: string) {
      // TTY: clear the live line, push the diagnostic out with its own
      // newline so it stays on screen, then redraw the live line below
      // it. Without this, --verbose either stomps over the cursor or
      // (today's bug) gets suppressed entirely. Non-TTY: plain stderr.
      if (isTty) {
        out.write(`\r\x1b[2K${msg}\n`);
        live();
      } else {
        out.write(`${msg}\n`);
      }
    },
    done(outcome: string) {
      if (interval) clearInterval(interval);
      if (isTty) {
        out.write(`\r\x1b[2K  [${idx}/${total}] ${relPath} · ${outcome}\n`);
      } else {
        const elapsed = Math.round((Date.now() - stageStart) / 1000);
        out.write(`  [${idx}/${total}] ${relPath} · ${outcome} (${elapsed}s in ${stage})\n`);
      }
    },
  };
}

// The batch walker reports relPath as the path under the parent dir
// (e.g. "SHOW_S1_HDBEE/S1 D1"). When called from the single-disc
// flow we don't have that context, so fall back to basename(absPath).
async function planSingleDisc(
  absPath: string,
  opts: CliOpts,
  relPathOverride?: string,
  progress?: PlanProgressSink,
): Promise<DiscPlan> {
  const relPath = relPathOverride ?? basename(absPath);

  let minLengthSkipS: number | null;
  try {
    minLengthSkipS = parseDurationFlag(opts.minLengthSkip);
  } catch (e) {
    return {
      kind: "blocked",
      relPath,
      absPath,
      stage: "scan",
      reason: (e as Error).message,
    };
  }

  const cfg = loadConfig({
    outDir: opts.out,
    dbPath: opts.db,
    defaultOutDir: defaultLibraryDir(absPath),
  });
  if (!cfg.tmdbApiKey) {
    return {
      kind: "blocked",
      relPath,
      absPath,
      stage: "scan",
      reason: "BDREMUXER_TMDB_API_KEY is required for identification.",
    };
  }

  let makemkvcon: string;
  try {
    makemkvcon = discoverMakemkvcon({ override: opts.makemkvcon });
  } catch (e) {
    return {
      kind: "blocked",
      relPath,
      absPath,
      stage: "scan",
      reason: (e as Error).message,
    };
  }

  const log = (msg: string) => {
    if (!opts.verbose) return;
    // When a progress sink is active, route verbose lines through it so
    // they sit above the live line instead of stomping the cursor.
    if (progress) progress.log(`[bdremuxer] [plan] ${relPath}: ${msg}`);
    else process.stderr.write(`[bdremuxer] [plan] ${relPath}: ${msg}\n`);
  };

  progress?.setStage(/\.iso$/i.test(absPath) ? "mounting" : "opening");
  let source: DiscSource;
  try {
    source = await openDiscSource(absPath, {
      mountRoot: join(tmpdir(), "bdremuxer-mounts"),
      log,
      emitEvent: opts.json ? emitJson : undefined,
    });
  } catch (e) {
    const { code, suggestion } = classifyDiscOpenError(e);
    return {
      kind: "blocked",
      relPath,
      absPath,
      stage: "scan",
      reason: (e as Error).message,
      ...(code !== undefined ? { code } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    };
  }
  const discRoot = source.bdmvPath;

  const db = openDb(cfg.dbPath);
  try {
    progress?.setStage("scanning");
    const scanRes = await scan(db, source);
    const shortFp = scanRes.fingerprint.slice(0, 12);

    // Already-done bookkeeping. Distinguishes:
    //   already-done — every expected MKV still on disk; phase 2 will skip.
    //   stale-done   — status='done' but outputs missing; needs --force.
    if (!opts.force && scanRes.disc.status === "done") {
      const stale = checkStaleDone(db, scanRes.disc.id);
      if (!stale.ok) {
        return { kind: "stale-done", relPath, absPath, disc: scanRes.disc, missingOutputs: stale.missing };
      }
      const mainOut = db
        .query<{ output_path: string | null }, [number]>(
          `SELECT output_path FROM title WHERE disc_id = ? AND role = 'main'`,
        )
        .get(scanRes.disc.id);
      return {
        kind: "already-done",
        relPath,
        absPath,
        disc: scanRes.disc,
        outputPath: mainOut?.output_path ?? null,
      };
    }

    // Probe — skipped when titles are cached.
    progress?.setStage("probing");
    let titleRows: TitleRow[];
    const cachedTitles = db
      .query<TitleRow, [number]>(
        `SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`,
      )
      .all(scanRes.disc.id);
    if (cachedTitles.length > 0 && !opts.force) {
      titleRows = cachedTitles;
      log(`probe: reusing ${titleRows.length} cached titles`);
    } else {
      log("probe...");
      try {
        const { probe } = await runInfo({
          makemkvcon,
          source: `file:${discRoot}`,
          echoStderr: !!opts.verbose,
        });
        titleRows = persistProbe(db, scanRes.disc.id, probe);
      } catch (e) {
        return {
          kind: "blocked",
          relPath,
          absPath,
          stage: "probe",
          reason: (e as Error).message,
        };
      }
      log(`probe: ${titleRows.length} titles persisted`);
    }

    // Classify.
    progress?.setStage("classifying");
    const parentDirName = basename(dirname(source.originalPath));
    const typeFlag = opts.type === "auto" ? undefined : opts.type;
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
        return {
          kind: "blocked",
          relPath,
          absPath,
          stage: "classify",
          reason: e.message,
          suggestion: "Pass --type movie or --type tv (or type = '...' in batch.toml).",
        };
      }
      throw e;
    }
    const discClassified = persistMediaKind(db, scanRes.disc, kind);
    log(`classified: ${kind}`);

    const ctx: StageCtx = {
      db,
      disc: discClassified,
      titleRows,
      cfg,
      opts,
      scanRes,
      parentDirName,
      makemkvcon,
      source,
      discRoot,
      shortFp,
      minLengthSkipS,
      log,
    };

    progress?.setStage("identifying");
    if (kind === "tv") {
      const planResult = await planTv(ctx);
      if ("blocked" in planResult) {
        return {
          kind: "blocked",
          relPath,
          absPath,
          stage: planResult.stage,
          reason: planResult.reason,
          ...(planResult.suggestion !== undefined ? { suggestion: planResult.suggestion } : {}),
          ...(planResult.fix !== undefined ? { fix: planResult.fix } : {}),
        };
      }
      return {
        kind: "ready",
        relPath,
        absPath,
        shortFp,
        fingerprint: scanRes.fingerprint,
        volumeLabel: scanRes.volumeLabel || null,
        disc: planResult.persisted.disc,
        titleRows: db
          .query<TitleRow, [number]>(`SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`)
          .all(planResult.persisted.disc.id),
        media: planResult.data,
      };
    }
    // Movie path
    const planResult = await planMovie(ctx);
    if ("blocked" in planResult) {
      return {
        kind: "blocked",
        relPath,
        absPath,
        stage: planResult.stage,
        reason: planResult.reason,
        ...(planResult.suggestion !== undefined ? { suggestion: planResult.suggestion } : {}),
      };
    }
    return {
      kind: "ready",
      relPath,
      absPath,
      shortFp,
      fingerprint: scanRes.fingerprint,
      volumeLabel: scanRes.volumeLabel || null,
      disc: planResult.discIdentified,
      titleRows: db
        .query<TitleRow, [number]>(`SELECT * FROM title WHERE disc_id = ? ORDER BY makemkv_id`)
        .all(planResult.discIdentified.id),
      media: planResult.data,
    };
  } catch (e) {
    return {
      kind: "blocked",
      relPath,
      absPath,
      stage: "scan",
      reason: (e as Error).message,
    };
  } finally {
    db.close();
    try {
      await source.close();
    } catch {}
  }
}

// -------- Per-disc execution (phase 2 of preflight) ----------------------
//
// Take a ready plan and run remux + finalize. Owns its own DB connection.
// Reconstructs StageCtx from the plan (everything the executors need is
// either on the plan or recomputable from opts).

async function executePlannedDisc(
  plan: DiscPlanReady,
  opts: CliOpts,
): Promise<number> {
  const cfg = loadConfig({
    outDir: opts.out,
    dbPath: opts.db,
    defaultOutDir: defaultLibraryDir(plan.absPath),
  });
  let makemkvcon: string;
  try {
    makemkvcon = discoverMakemkvcon({ override: opts.makemkvcon });
  } catch (e) {
    reportError(opts, (e as Error).message);
    return 1;
  }
  const log = (msg: string) => {
    if (opts.verbose) process.stderr.write(`[bdremuxer] [exec] ${plan.relPath}: ${msg}\n`);
  };

  let minLengthSkipS: number | null;
  try {
    minLengthSkipS = parseDurationFlag(opts.minLengthSkip);
  } catch (e) {
    reportError(opts, (e as Error).message);
    return 2;
  }

  let source: DiscSource;
  try {
    source = await openDiscSource(plan.absPath, {
      mountRoot: join(tmpdir(), "bdremuxer-mounts"),
      log,
      emitEvent: opts.json ? emitJson : undefined,
    });
  } catch (e) {
    reportError(opts, formatDiscOpenError(e));
    return 1;
  }
  const discRoot = source.bdmvPath;

  const db = openDb(cfg.dbPath);
  try {
    const ctx: StageCtx = {
      db,
      disc: plan.disc,
      titleRows: plan.titleRows,
      cfg,
      opts,
      scanRes: {
        fingerprint: plan.fingerprint,
        volumeLabel: plan.volumeLabel ?? "",
        disc: plan.disc,
      },
      parentDirName: basename(dirname(source.originalPath)),
      makemkvcon,
      source,
      discRoot,
      shortFp: plan.shortFp,
      minLengthSkipS,
      log,
    };
    if (plan.media.kind === "movie") {
      return await executeMoviePlan(ctx, plan.media, plan.disc);
    }
    // Build a PersistedTv-shaped object from the plan data for executeTvPlan.
    return await executeTvPlan(
      ctx,
      plan.media,
      {
        disc: plan.disc,
        show: plan.media.show,
        season: plan.media.season,
        episodes: plan.media.episodes,
      },
    );
  } catch (e) {
    reportError(opts, (e as Error).message);
    return 1;
  } finally {
    db.close();
    try {
      await source.close();
    } catch {}
  }
}

// -------- Movie pipeline: split into plan + execute halves --------------
//
// planMovie: identify (TMDB / OMDb fallback) → persist movie → select →
// persist selection. Returns the planning data or a Blocked record so the
// preflight pass can aggregate issues instead of aborting at the first one.
// All DB writes are idempotent re-runs are safe.
//
// executeMoviePlan: remux + finalize, using the data planMovie produced.
// The disc passed in is the post-identify row (movie_id set).

type BlockedReason = {
  blocked: true;
  stage: "identify" | "select";
  reason: string;
  suggestion?: string;
  fix?: import("./pipeline/plan.ts").DiscPlanFix;
};

async function planMovie(
  ctx: StageCtx,
): Promise<{ data: MoviePlanData; discIdentified: DiscRow } | BlockedReason> {
  const { db, opts, log, cfg, titleRows, scanRes, parentDirName, minLengthSkipS } = ctx;

  log("identify (TMDB)...");
  const client = new TmdbClient({ apiKey: cfg.tmdbApiKey! });
  const omdbClient = cfg.omdbApiKey
    ? new OmdbClient({ apiKey: cfg.omdbApiKey })
    : null;
  let identified;
  try {
    identified = await identifyMovie({
      client,
      omdbClient,
      tmdbId: opts.tmdbId,
      imdbId: opts.imdbId,
      titleHint: opts.title,
      volumeLabel: scanRes.volumeLabel,
      parentDirName,
    });
  } catch (e) {
    if (e instanceof AmbiguousMatchError) {
      const candidates = e.candidates
        .slice(0, 5)
        .map((c) => `TMDB:${c.id} ${c.title} (${c.release_date?.slice(0, 4) ?? "????"})`)
        .join(", ");
      return {
        blocked: true,
        stage: "identify",
        reason: `Multiple close TMDB candidates: ${candidates}`,
        suggestion: "Pin the match with --tmdb-id or --imdb-id (or tmdb_id / imdb_id in batch.toml).",
      };
    }
    return { blocked: true, stage: "identify", reason: (e as Error).message };
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

  return {
    data: { kind: "movie", movie, selection, identifySource: identified.source },
    discIdentified,
  };
}

async function executeMoviePlan(
  ctx: StageCtx,
  planData: MoviePlanData,
  discIdentified: DiscRow,
): Promise<number> {
  const { db, opts, cfg, makemkvcon, discRoot, shortFp } = ctx;
  const { movie, selection } = planData;

  const runId = startRun(db, discIdentified.id);
  try {
    const printer = makeMovieProgressPrinter(!!opts.json);
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

    if (opts.json) {
      emitJson("done", {
        media_kind: "movie",
        movie: { tmdb_id: movie.tmdb_id, imdb_id: movie.imdb_id, title: movie.title, year: movie.year },
        main: { output_path: remuxResult.main.outputPath, skipped: remuxResult.main.skipped },
        extras: remuxResult.extras.map((e) => ({ output_path: e.outputPath, skipped: e.skipped })),
        manifest_path: manifestPath,
        log_path: remuxResult.logPath,
      });
    } else {
      printDone({
        movie,
        main: remuxResult.main,
        extras: remuxResult.extras,
        manifestPath,
        logPath: remuxResult.logPath,
      });
    }
    return 0;
  } catch (e) {
    finishRun(db, runId, false);
    markDiscFailed(db, discIdentified.id, "remuxed");
    throw e;
  }
}

async function runMoviePipeline(ctx: StageCtx): Promise<number> {
  const planResult = await planMovie(ctx);
  if ("blocked" in planResult) {
    reportBlocked(ctx.opts, planResult);
    return 1;
  }
  const { data, discIdentified } = planResult;
  if (ctx.opts.dryRun) {
    if (ctx.opts.json) {
      emitJson(
        "plan",
        buildMoviePlanEvent(discIdentified, data.movie, data.selection, data.identifySource),
      );
    } else {
      printPlan({
        db: ctx.db,
        disc: discIdentified,
        movie: data.movie,
        selection: data.selection,
        source: data.identifySource,
        dryRun: true,
      });
    }
    return 0;
  }
  return await executeMoviePlan(ctx, data, discIdentified);
}

function reportBlocked(opts: CliOpts, b: BlockedReason): void {
  if (opts.json) {
    emitJson("error", {
      message: b.reason,
      stage: b.stage,
      suggestion: b.suggestion ?? null,
    });
  } else {
    process.stderr.write(`${b.reason}\n`);
    if (b.suggestion) process.stderr.write(`  → ${b.suggestion}\n`);
  }
}

// -------- TV pipeline: plan + execute halves -------------------------------

type PersistedTv = ReturnType<typeof persistTvIdentification>;

async function planTv(
  ctx: StageCtx,
): Promise<
  | { data: TvPlanData; persisted: PersistedTv }
  | BlockedReason
> {
  const { db, opts, log, cfg, titleRows, scanRes, parentDirName, minLengthSkipS } = ctx;

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
      const candidates = e.candidates
        .slice(0, 5)
        .map((c) => `TMDB:${c.id} ${c.name} (${c.first_air_date?.slice(0, 4) ?? "????"})`)
        .join(", ");
      return {
        blocked: true,
        stage: "identify",
        reason: `Multiple close TMDB candidates: ${candidates}`,
        suggestion: "Pin the show with --tmdb-show-id (or tmdb_show_id in batch.toml).",
      };
    }
    return { blocked: true, stage: "identify", reason: (e as Error).message };
  }
  const persisted = persistTvIdentification(db, ctx.disc, tvIdentified);
  log(
    `identified: show=tmdb:${tvIdentified.show.id} season=${tvIdentified.season.season_number} ` +
      `(${tvIdentified.effectiveEpisodeOrder} order, season via ${tvIdentified.seasonSource}) ` +
      `episodes=${persisted.episodes.length}`,
  );

  let tvSelection;
  try {
    tvSelection = selectTv({
      titles: titleRows,
      episodes: persisted.episodes,
      minLengthSkipS,
      startingEpisode: opts.startingEpisode,
      includeExtras: !!opts.includeExtras,
    });
  } catch (e) {
    return { blocked: true, stage: "select", reason: (e as Error).message };
  }

  // Episode-allocation collision guard (see spec-preflight §5 + the
  // EpisodeAllocationConflictError that catches the "every disc defaulted
  // to starting_episode=1" footgun).
  const candidateEpIds = tvSelection.episodeMap.map((m) => m.episode.id);
  const conflicts = findEpisodeAllocationConflicts(db, persisted.disc.id, candidateEpIds);
  if (conflicts.length > 0) {
    const highest = highestClaimedEpisodeInSeason(db, persisted.season.id, persisted.disc.id);
    const err = new EpisodeAllocationConflictError(
      conflicts,
      persisted.season.season_number,
      persisted.show.name,
      highest !== null ? highest + 1 : null,
    );
    return {
      blocked: true,
      stage: "select",
      reason: err.message,
      ...(highest !== null
        ? {
            // Neutral wording: works in both contexts. init-batch will
            // auto-patch this value into bdremuxer.batch.toml; plain
            // batch users edit the TOML themselves. Either way, the
            // user should sanity-check that this is actually the first
            // episode on this disc — the value is computed from "next
            // unclaimed episode in the season", which is almost always
            // right but worth a glance for split-finale layouts.
            suggestion: `Starting episode will be set to ${highest + 1} for this disc — verify this is correct.`,
            fix: { kind: "set-starting-episode", value: highest + 1 },
          }
        : {
            suggestion:
              "Set starting_episode for this disc manually in bdremuxer.batch.toml — the conflict detector couldn't compute a suggestion.",
          }),
    };
  }

  persistTvSelection(db, persisted.disc.id, tvSelection);
  log(
    `selected: ${tvSelection.episodeMap.length} episodes` +
      (tvSelection.cohort.outlierIncluded ? " (incl. outlier)" : ""),
  );

  return {
    data: {
      kind: "tv",
      show: persisted.show,
      season: persisted.season,
      episodes: persisted.episodes,
      selection: tvSelection,
      identifySource: tvIdentified.source,
      seasonSource: tvIdentified.seasonSource,
      effectiveEpisodeOrder: tvIdentified.effectiveEpisodeOrder,
    },
    persisted,
  };
}

async function executeTvPlan(
  ctx: StageCtx,
  planData: TvPlanData,
  persisted: PersistedTv,
): Promise<number> {
  const { db, opts, cfg, makemkvcon, discRoot, shortFp } = ctx;
  const tvRunId = startRun(db, persisted.disc.id);
  try {
    const tvPrinter = makeTvProgressPrinter(!!opts.json);
    const remuxResult = await remuxTvEpisodes({
      db,
      outDir: cfg.outDir,
      outputFormat: opts.outputFormat,
      makemkvcon,
      discRoot,
      disc: persisted.disc,
      show: planData.show,
      season: planData.season,
      episodeMap: planData.selection.episodeMap,
      extras: planData.selection.extras,
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
        show: planData.show,
        season: planData.season,
        episodes: planData.episodes,
      },
    });

    if (opts.json) {
      emitJson("done", {
        media_kind: "tv",
        show: {
          tmdb_id: planData.show.tmdb_id,
          imdb_id: planData.show.imdb_id,
          name: planData.show.name,
          first_air_year: planData.show.first_air_year,
        },
        season: { season_number: planData.season.season_number },
        episodes: remuxResult.episodes.map((o) => ({
          episode_number: o.episode.episode_number,
          name: o.episode.name,
          output_path: o.outputPath,
          skipped: o.skipped,
        })),
        extras: remuxResult.extras.map((e) => ({ output_path: e.outputPath, skipped: e.skipped })),
        manifest_path: manifestPath,
        log_path: remuxResult.logPath,
      });
    } else {
      printTvDone({
        show: planData.show,
        seasonNumber: planData.season.season_number,
        episodes: remuxResult.episodes,
        extras: remuxResult.extras,
        manifestPath,
        logPath: remuxResult.logPath,
      });
    }
    return 0;
  } catch (e) {
    finishRun(db, tvRunId, false);
    markDiscFailed(db, persisted.disc.id, "remuxed");
    throw e;
  }
}

async function runTvPipeline(ctx: StageCtx): Promise<number> {
  const planResult = await planTv(ctx);
  if ("blocked" in planResult) {
    reportBlocked(ctx.opts, planResult);
    return 1;
  }
  const { data, persisted } = planResult;
  if (ctx.opts.dryRun) {
    if (ctx.opts.json) {
      emitJson(
        "plan",
        buildTvPlanEvent(
          persisted.disc,
          data.show,
          data.season.season_number,
          data.effectiveEpisodeOrder,
          data.selection,
          data.identifySource,
          data.seasonSource,
        ),
      );
    } else {
      printTvPlan({
        db: ctx.db,
        disc: persisted.disc,
        show: data.show,
        seasonNumber: data.season.season_number,
        effectiveEpisodeOrder: data.effectiveEpisodeOrder,
        selection: data.selection,
        source: data.identifySource,
        seasonSource: data.seasonSource,
        dryRun: true,
      });
    }
    return 0;
  }
  return await executeTvPlan(ctx, data, persisted);
}

// -----------------------------------------------------------------------
// Progress printers
// -----------------------------------------------------------------------

type MoviePrinter = {
  onMainProgress: (frac: number, task?: string) => void;
  onExtraProgress: (idx: number, total: number, frac: number, task?: string) => void;
  onTitleDone: (kind: "main" | "extra", idx: number, total: number, skipped: boolean) => void;
};

function makeMovieProgressPrinter(json: boolean): MoviePrinter {
  if (json) {
    return {
      onMainProgress: (frac, task) =>
        emitJson("progress", { title_kind: "main", frac, task: task ?? null }),
      onExtraProgress: (idx, total, frac, task) =>
        emitJson("progress", {
          title_kind: "extra",
          idx,
          total,
          frac,
          task: task ?? null,
        }),
      onTitleDone: (kind, idx, total, skipped) =>
        emitJson("title_done", { title_kind: kind, idx, total, skipped }),
    };
  }
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

type TvPrinter = {
  onEpisodeProgress: (epIdx: number, epTotal: number, frac: number, task?: string) => void;
  onExtraProgress: (idx: number, total: number, frac: number, task?: string) => void;
  onTitleDone: (kind: "episode" | "extra", idx: number, total: number, skipped: boolean) => void;
};

function makeTvProgressPrinter(json: boolean): TvPrinter {
  if (json) {
    return {
      onEpisodeProgress: (idx, total, frac, task) =>
        emitJson("progress", {
          title_kind: "episode",
          idx,
          total,
          frac,
          task: task ?? null,
        }),
      onExtraProgress: (idx, total, frac, task) =>
        emitJson("progress", {
          title_kind: "extra",
          idx,
          total,
          frac,
          task: task ?? null,
        }),
      onTitleDone: (kind, idx, total, skipped) =>
        emitJson("title_done", { title_kind: kind, idx, total, skipped }),
    };
  }
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

// JSON event builders ----------------------------------------------------

function buildMoviePlanEvent(
  disc: DiscRow,
  movie: MovieRow,
  selection: MovieSelection,
  source: string,
): Record<string, unknown> {
  return {
    media_kind: "movie",
    source,
    disc: {
      fingerprint: disc.fingerprint,
      volume_label: disc.volume_label,
    },
    movie: {
      tmdb_id: movie.tmdb_id,
      imdb_id: movie.imdb_id,
      title: movie.title,
      year: movie.year,
      runtime_min: movie.runtime_min,
    },
    main: {
      makemkv_id: selection.main.makemkv_id,
      duration_s: selection.main.duration_s,
      segment_map: selection.main.segment_map,
    },
    extras: selection.extras.map((t) => ({
      makemkv_id: t.makemkv_id,
      duration_s: t.duration_s,
    })),
    skipped: selection.skipped.map(({ title, reason }) => ({
      makemkv_id: title.makemkv_id,
      duration_s: title.duration_s,
      reason,
    })),
  };
}

function buildTvPlanEvent(
  disc: DiscRow,
  show: { id: number; name: string; imdb_id: string | null },
  seasonNumber: number,
  episodeOrder: EpisodeOrder,
  selection: TvSelection,
  source: string,
  seasonSource: "flag" | "parsed",
): Record<string, unknown> {
  return {
    media_kind: "tv",
    source,
    season_source: seasonSource,
    disc: {
      fingerprint: disc.fingerprint,
      volume_label: disc.volume_label,
    },
    show: {
      tmdb_id: show.id,
      imdb_id: show.imdb_id,
      name: show.name,
    },
    season: { season_number: seasonNumber, episode_order: episodeOrder },
    cohort: {
      count: selection.cohort.count,
      median_s: selection.cohort.median,
      rel_stdev: selection.cohort.relStdev,
      outlier_makemkv_id: selection.cohort.outlierIncluded?.makemkv_id ?? null,
    },
    episode_map: selection.episodeMap.map(({ title, episode }) => ({
      makemkv_id: title.makemkv_id,
      duration_s: title.duration_s,
      episode_number: episode.episode_number,
      episode_name: episode.name,
    })),
    extras: selection.extras.map((t) => ({
      makemkv_id: t.makemkv_id,
      duration_s: t.duration_s,
    })),
    skipped: selection.skipped.map(({ title, reason }) => ({
      makemkv_id: title.makemkv_id,
      duration_s: title.duration_s,
      reason,
    })),
  };
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

/**
 * Compute the "library directory" — the parent of the disc location —
 * used as `defaultOutDir` when no `--out` / `$BDREMUXER_OUTPUT_DIR` is
 * set. Computed without opening a DiscSource because config loading
 * needs to happen before the source can be opened (the ISO backend's
 * mount root sits under `<out>/.bdremuxer/mounts`).
 *
 * - Folder input pointing at BDMV/ or BDMV/index.bdmv: collapse to the
 *   disc root, return its parent.
 * - Folder input pointing at the disc root: return its parent.
 * - `.iso` file: return its parent directory.
 */
function defaultLibraryDir(input: string): string {
  const abs = resolve(input);
  if (/\.iso$/i.test(abs)) return dirname(abs);
  return dirname(normalizeBdmvDir(input));
}

/**
 * Format a DiscSource open-time error for single-disc / executePlannedDisc
 * stderr output, appending the suggestion line when one is available.
 * The batch preflight uses the structured (code, suggestion) fields on
 * the blocked plan instead and goes through formatIssueReport.
 */
function formatDiscOpenError(err: unknown): string {
  const msg = (err as Error).message;
  const { suggestion } = classifyDiscOpenError(err);
  return suggestion ? `${msg}\n  → ${suggestion}` : msg;
}
