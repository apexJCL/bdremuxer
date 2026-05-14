// `bdremuxer init-batch <parent-dir>` — scaffold a bdremuxer.batch.toml
// either interactively (wizard) or as a commented template (--empty).
//
// The wizard:
//   - walks <parent-dir> for BDMV folders (reuses the M8 walker)
//   - groups discs that share a (show, season) hint per parseSeasonHint
//   - prompts once per group, plus once per singleton, for the fields
//     that matter most (type, show/title, season, include_extras)
//   - emits a glob block per TV group and a literal-path block per
//     singleton or per-disc disambiguation point
//
// What it intentionally doesn't do: ask per-disc starting_episode (too
// cognitively heavy — the generated file includes TODO comments telling
// the user to fill those in). Also doesn't hit TMDB.

import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { walkBdmvFolders, type DiscDir } from "./batch.ts";
import { parseSeasonHint } from "./parse/season-hint.ts";
import type { Prompter } from "./parse/prompt.ts";

// -----------------------------------------------------------------------
// Output path + write guard
// -----------------------------------------------------------------------

const BATCH_FILENAME = "bdremuxer.batch.toml";

export function targetPath(parentDir: string): string {
  return join(parentDir, BATCH_FILENAME);
}

export function writeTomlOrError(
  path: string,
  contents: string,
  force: boolean,
): void {
  if (existsSync(path) && !force) {
    throw new Error(
      `${path} already exists. Re-run with --force to overwrite.`,
    );
  }
  writeFileSync(path, contents);
}

// -----------------------------------------------------------------------
// Empty template
// -----------------------------------------------------------------------

const EMPTY_TEMPLATE = `# bdremuxer batch override file
#
# Place this file at <parent-dir>/bdremuxer.batch.toml. \`bdremuxer batch
# <parent-dir>\` will merge these overrides onto the CLI flags before
# processing each disc.
#
# Block keys are globs matched against subdirectory paths relative to
# this file:
#   *   — any run of characters except /
#   **  — any run of characters including /
#
# Resolution order (last wins):
#   1. main config defaults
#   2. CLI flags
#   3. matching glob blocks here (in file order — declare broader globs
#      first, more-specific ones below them)
#   4. per-disc sidecar at <parent>/<disc>/bdremuxer.toml
#
# Keys are the snake_case versions of the CLI flag names (e.g.
# starting_episode = 1 maps to --starting-episode 1).

# --- Examples (delete or replace) ---

# ["Breaking Bad - S2*"]
# type             = "tv"
# show             = "Breaking Bad (2008)"
# season           = 2
# include_extras   = true
#
# ["Breaking Bad - S2 - Disc 1"]
# starting_episode = 1
#
# ["Breaking Bad - S2 - Disc 2"]
# starting_episode = 4
#
# ["Movies/*"]
# type             = "movie"
`;

export function emptyTemplate(): string {
  return EMPTY_TEMPLATE;
}

// -----------------------------------------------------------------------
// Disc grouping (pure)
// -----------------------------------------------------------------------

export type DiscGroup = {
  /** True when ≥ 2 discs share a (show, season) hint. */
  isTvGroup: boolean;
  /** Inferred from the first member's path when available. */
  inferredShowName?: string;
  inferredSeason?: number;
  /** TV-like singletons get inferredType='tv'; everything else is undecided. */
  inferredType?: "movie" | "tv";
  members: DiscDir[];
};

function lastSegment(p: string): string {
  return p.split("/").pop() ?? p;
}

export function groupDiscs(discs: DiscDir[]): DiscGroup[] {
  // Stable input order so the output is deterministic.
  const sorted = [...discs].sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Bucket by (show-lower, season) when both can be parsed.
  const buckets = new Map<
    string,
    { showName: string; season: number; members: DiscDir[] }
  >();
  const orphans: DiscDir[] = [];

  for (const d of sorted) {
    const hint = parseSeasonHint(lastSegment(d.relPath));
    if (hint.show && hint.season != null) {
      const key = `${hint.show.toLowerCase()}|S${hint.season}`;
      let b = buckets.get(key);
      if (!b) {
        b = { showName: hint.show, season: hint.season, members: [] };
        buckets.set(key, b);
      }
      b.members.push(d);
    } else {
      orphans.push(d);
    }
  }

  const groups: DiscGroup[] = [];
  for (const b of buckets.values()) {
    if (b.members.length >= 2) {
      groups.push({
        isTvGroup: true,
        inferredShowName: b.showName,
        inferredSeason: b.season,
        inferredType: "tv",
        members: b.members,
      });
    } else {
      // Single disc with a TV-shaped path → still a TV singleton.
      groups.push({
        isTvGroup: false,
        inferredShowName: b.showName,
        inferredSeason: b.season,
        inferredType: "tv",
        members: b.members,
      });
    }
  }
  for (const d of orphans) {
    groups.push({ isTvGroup: false, inferredType: "movie", members: [d] });
  }

  // TV groups first (so users see the consolidated ones up front), then
  // singletons in the bucket order they were created.
  groups.sort((a, b) => (a.isTvGroup === b.isTvGroup ? 0 : a.isTvGroup ? -1 : 1));
  return groups;
}

// -----------------------------------------------------------------------
// Wizard answers → TOML blocks (pure)
// -----------------------------------------------------------------------

export type WizardBlock = {
  glob: string;
  comment?: string;
  /** Insertion order is preserved in the output. */
  values: Record<string, string | number | boolean>;
};

export type WizardAnswers = Array<TvGroupAnswer | SingletonAnswer | SkippedAnswer>;

export type TvGroupAnswer = {
  kind: "tv-group";
  members: DiscDir[];
  show: string;
  season: number;
  tmdbShowId?: number;
  includeExtras: boolean;
};

export type SingletonAnswer = {
  kind: "singleton";
  member: DiscDir;
  type: "movie" | "tv";
  show?: string;
  season?: number;
  tmdbShowId?: number;
  title?: string;
  tmdbId?: number;
  includeExtras: boolean;
};

export type SkippedAnswer = {
  kind: "skipped";
  members: DiscDir[];
};

function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0]!;
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i]!.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix === "") return "";
    }
  }
  return prefix;
}

export function buildBatchBlocks(answers: WizardAnswers): WizardBlock[] {
  const blocks: WizardBlock[] = [];
  for (const a of answers) {
    if (a.kind === "skipped") continue;
    if (a.kind === "tv-group") {
      const prefix = commonPrefix(a.members.map((m) => m.relPath));
      // If the discs literally share an identical prefix (e.g.
      // "Breaking Bad - S2 - Disc ") use `prefix*`; otherwise fall back
      // to a per-member listing under the group glob.
      const glob = prefix !== "" ? `${prefix}*` : a.members[0]!.relPath;
      const values: WizardBlock["values"] = {
        type: "tv",
        show: a.show,
        season: a.season,
      };
      if (a.tmdbShowId !== undefined) values.tmdb_show_id = a.tmdbShowId;
      if (a.includeExtras) values.include_extras = true;
      blocks.push({
        glob,
        comment:
          `Matches ${a.members.length} disc(s): ${a.members.map((m) => basename(m.relPath)).join(", ")}\n` +
          `TODO: set starting_episode = N per disc in the blocks below.`,
        values,
      });
      // One block per disc with a TODO placeholder for starting_episode.
      for (const m of a.members) {
        blocks.push({
          glob: m.relPath,
          values: { starting_episode: 1 },
          comment: `TODO: change to the actual first-episode number on this disc.`,
        });
      }
      continue;
    }
    // singleton
    const values: WizardBlock["values"] = { type: a.type };
    if (a.type === "tv") {
      if (a.show) values.show = a.show;
      if (a.season !== undefined) values.season = a.season;
      if (a.tmdbShowId !== undefined) values.tmdb_show_id = a.tmdbShowId;
    } else {
      if (a.title) values.title = a.title;
      if (a.tmdbId !== undefined) values.tmdb_id = a.tmdbId;
    }
    if (a.includeExtras) values.include_extras = true;
    blocks.push({ glob: a.member.relPath, values });
  }
  return blocks;
}

// -----------------------------------------------------------------------
// TOML serializer (pure)
// -----------------------------------------------------------------------

const HEADER =
  `# bdremuxer batch override file — generated by \`bdremuxer init-batch\`.
# Edit freely. See \`bdremuxer init-batch --empty --force\` for the full
# format reference.\n\n`;

export function serializeBatchToml(blocks: WizardBlock[]): string {
  let out = HEADER;
  for (const b of blocks) {
    if (b.comment) {
      for (const line of b.comment.split("\n")) out += `# ${line}\n`;
    }
    out += `["${escapeTomlString(b.glob)}"]\n`;
    for (const [k, v] of Object.entries(b.values)) {
      out += `${k} = ${tomlValue(v)}\n`;
    }
    out += "\n";
  }
  return out.trimEnd() + "\n";
}

function escapeTomlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tomlValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  return `"${escapeTomlString(v)}"`;
}

// -----------------------------------------------------------------------
// Wizard runner (interactive)
// -----------------------------------------------------------------------

export type RunInitBatchOpts = {
  parentDir: string;
  empty: boolean;
  force: boolean;
  prompter?: Prompter;
};

export async function runInitBatch(opts: RunInitBatchOpts): Promise<{
  path: string;
  bytes: number;
  discCount: number;
}> {
  const parentAbs = resolve(opts.parentDir);
  const path = targetPath(parentAbs);

  if (opts.empty) {
    writeTomlOrError(path, emptyTemplate(), opts.force);
    return { path, bytes: emptyTemplate().length, discCount: 0 };
  }

  const discs = walkBdmvFolders(parentAbs);
  if (discs.length === 0) {
    throw new Error(`No BDMV folders found under ${parentAbs}`);
  }

  if (!opts.prompter) {
    throw new Error("Wizard mode requires a Prompter (call with --empty to skip).");
  }
  const prompter = opts.prompter;

  process.stdout.write(`Found ${discs.length} disc(s) under ${parentAbs}\n\n`);
  const groups = groupDiscs(discs);
  const answers: WizardAnswers = [];

  for (const group of groups) {
    if (group.isTvGroup) {
      process.stdout.write(
        `Group: ${group.members.length} discs — "${group.inferredShowName ?? "?"}" Season ${group.inferredSeason ?? "?"}\n`,
      );
      for (const m of group.members) process.stdout.write(`  - ${m.relPath}\n`);
      const proceed = await prompter.askChoice(
        "  Action",
        ["tv", "skip"] as const,
        "tv",
      );
      if (proceed === "skip") {
        answers.push({ kind: "skipped", members: group.members });
        process.stdout.write("\n");
        continue;
      }
      const show = await prompter.ask("  Show name", group.inferredShowName);
      const season = await prompter.askInt("  Season number", group.inferredSeason);
      const tmdbShowId = await prompter.askInt("  TMDB show id (optional, blank to search)");
      const includeExtras = await prompter.askBool("  Include extras?", false);
      answers.push({
        kind: "tv-group",
        members: group.members,
        show,
        season: season ?? group.inferredSeason ?? 1,
        ...(tmdbShowId !== null ? { tmdbShowId } : {}),
        includeExtras,
      });
    } else {
      const m = group.members[0]!;
      process.stdout.write(`Disc: ${m.relPath}\n`);
      const action = await prompter.askChoice(
        "  Type",
        ["movie", "tv", "skip"] as const,
        group.inferredType ?? "movie",
      );
      if (action === "skip") {
        answers.push({ kind: "skipped", members: group.members });
        process.stdout.write("\n");
        continue;
      }
      if (action === "tv") {
        const show = await prompter.ask("  Show name", group.inferredShowName);
        const season = await prompter.askInt("  Season number", group.inferredSeason);
        const tmdbShowId = await prompter.askInt("  TMDB show id (optional)");
        const includeExtras = await prompter.askBool("  Include extras?", false);
        answers.push({
          kind: "singleton",
          member: m,
          type: "tv",
          show,
          ...(season !== null ? { season } : {}),
          ...(tmdbShowId !== null ? { tmdbShowId } : {}),
          includeExtras,
        });
      } else {
        const title = await prompter.ask("  Title hint (optional)");
        const tmdbId = await prompter.askInt("  TMDB movie id (optional)");
        const includeExtras = await prompter.askBool("  Include extras?", false);
        answers.push({
          kind: "singleton",
          member: m,
          type: "movie",
          ...(title ? { title } : {}),
          ...(tmdbId !== null ? { tmdbId } : {}),
          includeExtras,
        });
      }
    }
    process.stdout.write("\n");
  }

  const blocks = buildBatchBlocks(answers);
  if (blocks.length === 0) {
    // Everything was skipped — still write a stub so the user has a starting point.
    writeTomlOrError(path, emptyTemplate(), opts.force);
    return { path, bytes: emptyTemplate().length, discCount: discs.length };
  }
  const contents = serializeBatchToml(blocks);
  writeTomlOrError(path, contents, opts.force);
  return { path, bytes: contents.length, discCount: discs.length };
}
