// M11: preflight pass — types + helpers shared by phase 1 (planning) and
// phase 2 (execution). Spec lives in spec-preflight.md.
//
// A DiscPlan is the in-memory record produced for each disc during phase 1.
// `ready` plans carry everything phase 2 needs to remux+finalize without
// re-querying TMDB or re-running the cohort detector. `blocked` plans
// surface user-actionable problems; `already-done` and `stale-done` cover
// the two re-run states (skip cheaply vs. flag for --force).

import { existsSync } from "node:fs";

import type {
  DB,
  DiscRow,
  EpisodeRow,
  MovieRow,
  SeasonRow,
  TitleRow,
  TvShowRow,
} from "../db.ts";
import type { MovieIdentifySource } from "./identify/movie.ts";
import type { MovieSelection } from "./select/movie.ts";
import type { TvSelection } from "./select/tv.ts";

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type MoviePlanData = {
  kind: "movie";
  movie: MovieRow;
  selection: MovieSelection;
  identifySource: MovieIdentifySource;
};

export type TvPlanData = {
  kind: "tv";
  show: TvShowRow;
  season: SeasonRow;
  episodes: EpisodeRow[];
  selection: TvSelection;
  identifySource: "direct-tmdb" | "search";
  seasonSource: "flag" | "parsed";
  effectiveEpisodeOrder: "broadcast" | "production" | "dvd";
};

export type DiscPlanReady = {
  kind: "ready";
  relPath: string;
  absPath: string;
  shortFp: string;
  fingerprint: string;
  volumeLabel: string | null;
  disc: DiscRow;
  titleRows: TitleRow[];
  media: MoviePlanData | TvPlanData;
};

// Structured fixes the preflight can write back to bdremuxer.batch.toml
// without the user having to copy/paste from the error message.
// Currently only the per-disc starting_episode case; widen as needed.
export type DiscPlanFix = { kind: "set-starting-episode"; value: number };

export type DiscPlanBlocked = {
  kind: "blocked";
  relPath: string;
  absPath: string;
  stage: "scan" | "probe" | "classify" | "identify" | "select";
  reason: string;
  /**
   * Machine-readable category for the blocker. Free-form string today;
   * known values:
   *
   *   - `iso_mount_failed` — hdiutil attach returned non-zero
   *   - `iso_no_bdmv` — ISO mounted but no BDMV/index.bdmv inside
   *
   * Unset for most other blockers (classify ambiguity, TMDB missing
   * results, episode-allocation conflicts) where the `stage` + `reason`
   * pair is enough.
   */
  code?: string;
  suggestion?: string;
  fix?: DiscPlanFix;
};

// A disc whose previous run succeeded (status='done') and whose output
// MKVs are still on disk. Skipped during phase 2 unless --force.
export type DiscPlanAlreadyDone = {
  kind: "already-done";
  relPath: string;
  absPath: string;
  disc: DiscRow;
  outputPath: string | null;
};

// status='done' but at least one expected output MKV is missing on disk
// (e.g. the user rm'd it, or finalize crashed mid-way). Flagged in the
// summary; --force re-includes it in phase 2.
export type DiscPlanStaleDone = {
  kind: "stale-done";
  relPath: string;
  absPath: string;
  disc: DiscRow;
  missingOutputs: string[];
};

export type DiscPlan =
  | DiscPlanReady
  | DiscPlanBlocked
  | DiscPlanAlreadyDone
  | DiscPlanStaleDone;

export type BatchPlan = {
  schemaVersion: 1;
  generatedAt: string;
  bdremuxerVersion: string;
  parentDir: string;
  outDir: string;
  plans: DiscPlan[];
};

// -----------------------------------------------------------------------
// Stale-done detection (Q17 always-on)
// -----------------------------------------------------------------------
//
// For every disc with status='done', verify each role∈('main','episode')
// title's output_path still exists on disk. Anything missing → stale-done.

export type StaleDoneCheck =
  | { ok: true }
  | { ok: false; missing: string[] };

export function checkStaleDone(db: DB, discId: number): StaleDoneCheck {
  const rows = db
    .query<{ output_path: string | null }, [number]>(
      `SELECT output_path FROM title
       WHERE disc_id = ?
         AND role IN ('main','episode')
         AND output_path IS NOT NULL`,
    )
    .all(discId);
  const missing: string[] = [];
  for (const r of rows) {
    if (r.output_path && !existsSync(r.output_path)) missing.push(r.output_path);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// -----------------------------------------------------------------------
// Plan summary printer (text mode)
// -----------------------------------------------------------------------

export type PlanCounts = {
  ready: number;
  blocked: number;
  alreadyDone: number;
  staleDone: number;
  total: number;
};

export function countPlans(plans: DiscPlan[]): PlanCounts {
  let ready = 0,
    blocked = 0,
    alreadyDone = 0,
    staleDone = 0;
  for (const p of plans) {
    if (p.kind === "ready") ready++;
    else if (p.kind === "blocked") blocked++;
    else if (p.kind === "already-done") alreadyDone++;
    else staleDone++;
  }
  return { ready, blocked, alreadyDone, staleDone, total: plans.length };
}

// Renders one disc's outcome line, e.g.:
//   ✓ SHOW_S1D1        tv: Show Name S01 · 9 episodes (E01-E09)
//   ✓ THE_THING        movie: The Thing (1982) · main + 2 extras
//   ⚠ MYSTERY_DISC     classify: top titles similar, no season hint
//   ⊙ EVIL_DEAD_II     already done (E01-E12 on disk)
//   ⚠ SHOW_S1D3        stale: status=done but 2 output(s) missing
export function formatPlanLine(p: DiscPlan): string {
  switch (p.kind) {
    case "ready": {
      const media = p.media;
      if (media.kind === "movie") {
        const yearPart = media.movie.year ? ` (${media.movie.year})` : "";
        const extras =
          media.selection.extras.length > 0
            ? ` + ${media.selection.extras.length} extra${media.selection.extras.length === 1 ? "" : "s"}`
            : "";
        return `  ✓ ${p.relPath}\n      movie: ${media.movie.title}${yearPart} · main${extras}`;
      } else {
        const eps = media.selection.episodeMap;
        const firstN = eps[0]?.episode.episode_number;
        const lastN = eps[eps.length - 1]?.episode.episode_number;
        const range =
          firstN != null && lastN != null
            ? firstN === lastN
              ? `E${pad(firstN)}`
              : `E${pad(firstN)}-E${pad(lastN)}`
            : "0 episodes";
        const trimmed = media.selection.cohortTrimmed;
        const extrasN = media.selection.extras.length;
        const extras = extrasN > 0 ? ` + ${extrasN} extras` : "";
        const marker = trimmed ? "ℹ" : "✓";
        const main =
          `  ${marker} ${p.relPath}\n      tv: ${media.show.name} S${pad(media.season.season_number)} · ` +
          `${eps.length} episode${eps.length === 1 ? "" : "s"} (${range})${extras}`;
        if (trimmed) {
          // The user almost certainly wants to inspect which titles got
          // demoted — surface counts on a second line and reference the
          // remux extras/ folder so they can re-classify by hand.
          return (
            main +
            `\n      cohort: detected ${trimmed.detected} title(s), seated ${trimmed.seatedAsEpisode} as episodes, ` +
            `demoted ${trimmed.demoted.length} to extras for manual review`
          );
        }
        return main;
      }
    }
    case "blocked":
      return `  ⚠ ${p.relPath}\n      ${p.stage}: ${p.reason}` +
        (p.suggestion ? `\n      → ${p.suggestion}` : "");
    case "already-done":
      return `  ⊙ ${p.relPath}\n      already done` +
        (p.outputPath ? ` (${p.outputPath})` : "");
    case "stale-done":
      return (
        `  ⚠ ${p.relPath}\n      stale: status=done but ${p.missingOutputs.length} output(s) missing.\n` +
        `      → Re-run with --force to redo this disc.`
      );
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Outcome rendered by the per-disc progress renderer when a disc
// finishes. `formatPlanLine` is the equivalent multi-line block used
// by the summary printer; this variant skips the disc-name prefix
// (the renderer already wrote `[i/N] <relPath> · `) and folds the
// reason + suggestion onto follow-up lines so a wide error stays
// readable instead of being truncated mid-message.
//
// May contain newlines — the renderer's `done()` writes the whole
// thing followed by a final `\n`, which terminals handle cleanly.
export function formatPlanOutcomeShort(p: DiscPlan): string {
  switch (p.kind) {
    case "ready":
      if (p.media.kind === "movie") {
        const yearPart = p.media.movie.year ? ` (${p.media.movie.year})` : "";
        return `✓ ready · movie: ${p.media.movie.title}${yearPart}`;
      }
      return (
        `✓ ready · tv: ${p.media.show.name} S${pad(p.media.season.season_number)} ` +
        `(${p.media.selection.episodeMap.length} ep)`
      );
    case "blocked": {
      const lines = [`⚠ blocked at ${p.stage}: ${p.reason}`];
      if (p.suggestion) lines.push(`      → ${p.suggestion}`);
      return lines.join("\n");
    }
    case "already-done":
      return "⊙ already done";
    case "stale-done": {
      const lines = [`⚠ stale: ${p.missingOutputs.length} output(s) missing`];
      // Mirror formatPlanLine: show up to 3 paths so the user can
      // recognise which ones to recreate before --force.
      for (const m of p.missingOutputs.slice(0, 3)) lines.push(`        - ${m}`);
      if (p.missingOutputs.length > 3) {
        lines.push(`        … and ${p.missingOutputs.length - 3} more`);
      }
      lines.push("      → Re-run with --force to redo this disc.");
      return lines.join("\n");
    }
  }
}

export function formatPlanSummary(
  plans: DiscPlan[],
  parentDir: string,
): string {
  const c = countPlans(plans);
  let out = `\n[plan]\n  Found ${c.total} disc(s) under ${parentDir}\n\n`;
  for (const p of plans) out += `${formatPlanLine(p)}\n`;
  out += `\n  → ${c.ready}/${c.total} ready · ${c.blocked} blocked · ${c.alreadyDone} done · ${c.staleDone} stale\n`;
  return out;
}

// Aggregated issue report — shown after the summary when any disc is
// blocked or stale-done. Designed to be the user's worklist before
// re-running the batch.
export function formatIssueReport(plans: DiscPlan[]): string {
  const issues = plans.filter(
    (p): p is DiscPlanBlocked | DiscPlanStaleDone =>
      p.kind === "blocked" || p.kind === "stale-done",
  );
  if (issues.length === 0) return "";
  let out = `\n${issues.length} disc(s) need attention before remux:\n\n`;
  for (const p of issues) {
    if (p.kind === "blocked") {
      out += `  ${p.relPath}\n    ${p.stage}: ${p.reason}\n`;
      if (p.suggestion) out += `    → ${p.suggestion}\n`;
    } else {
      out +=
        `  ${p.relPath}\n    status='done' but ${p.missingOutputs.length} output(s) missing on disk:\n`;
      for (const m of p.missingOutputs.slice(0, 3)) out += `      - ${m}\n`;
      if (p.missingOutputs.length > 3) {
        out += `      … and ${p.missingOutputs.length - 3} more\n`;
      }
      out += `    → Re-run with --force to redo this disc.\n`;
    }
    out += "\n";
  }
  return out;
}
