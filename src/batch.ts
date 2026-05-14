// `bdremuxer batch <parent-dir>` machinery (§7.1).
//
//   - walks the tree for `BDMV/index.bdmv` files
//   - loads two flavours of TOML overrides:
//       <parent>/bdremuxer.batch.toml      glob-keyed blocks
//       <parent>/<disc>/bdremuxer.toml     per-disc sidecar
//   - merges them onto the CLI flags using the resolution order from §7.1:
//       CLI flags → matching batch.toml glob blocks (in file order)
//                 → per-disc bdremuxer.toml sidecar

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { globMatch } from "./parse/glob.ts";
import type { CliOpts, OutputFormat } from "./opts.ts";
import type { EpisodeOrder } from "./db.ts";

// -----------------------------------------------------------------------
// Walking
// -----------------------------------------------------------------------

export type DiscDir = {
  /** Path relative to the batch root, used as glob-match input. */
  relPath: string;
  /** Absolute path to the directory that contains the BDMV folder. */
  absPath: string;
};

export function walkBdmvFolders(root: string): DiscDir[] {
  const out: DiscDir[] = [];
  const walk = (abs: string, rel: string): void => {
    // If this directory itself is a disc root (contains BDMV/index.bdmv),
    // record it and stop descending — discs don't nest inside each other.
    if (isDiscRoot(abs)) {
      out.push({ relPath: rel, absPath: abs });
      return;
    }
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      // Skip the `.bdremuxer` working dir and dotfile dirs entirely.
      if (ent.name.startsWith(".")) continue;
      walk(join(abs, ent.name), rel ? `${rel}/${ent.name}` : ent.name);
    }
  };
  walk(root, "");
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function isDiscRoot(dir: string): boolean {
  try {
    return statSync(join(dir, "BDMV", "index.bdmv")).isFile();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Override resolution
// -----------------------------------------------------------------------

export type TomlOverrides = Partial<CliOpts>;

export type GlobBlock = { glob: string; overrides: TomlOverrides };

export function loadBatchOverrides(parentRoot: string): GlobBlock[] {
  const path = join(parentRoot, "bdremuxer.batch.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed = parseToml(text) as Record<string, unknown>;
  const blocks: GlobBlock[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      blocks.push({ glob: key, overrides: tomlBlockToOverrides(value as Record<string, unknown>) });
    }
  }
  return blocks;
}

export function loadSidecarOverrides(discRoot: string): TomlOverrides | null {
  const path = join(discRoot, "bdremuxer.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseToml(text) as Record<string, unknown>;
  return tomlBlockToOverrides(parsed);
}

// snake_case TOML key → camelCase CliOpts key, with light value validation.
// Unknown keys are silently dropped so future flag additions don't trip
// older sidecars (and vice-versa).
export function tomlBlockToOverrides(block: Record<string, unknown>): TomlOverrides {
  const out: TomlOverrides = {};
  const setStr = (k: keyof TomlOverrides, v: unknown) => {
    if (typeof v === "string") (out as Record<string, unknown>)[k] = v;
  };
  const setNum = (k: keyof TomlOverrides, v: unknown) => {
    if (typeof v === "number" && Number.isInteger(v)) {
      (out as Record<string, unknown>)[k] = v;
    }
  };
  const setBool = (k: keyof TomlOverrides, v: unknown) => {
    if (typeof v === "boolean") (out as Record<string, unknown>)[k] = v;
  };
  const setChoice = <K extends keyof TomlOverrides>(
    k: K,
    v: unknown,
    allowed: ReadonlyArray<TomlOverrides[K]>,
  ) => {
    if (typeof v === "string" && (allowed as readonly unknown[]).includes(v)) {
      (out as Record<string, unknown>)[k] = v;
    }
  };

  for (const [key, value] of Object.entries(block)) {
    switch (key) {
      case "type":
        setChoice("type", value, ["movie", "tv", "auto"] as const);
        break;
      case "title": setStr("title", value); break;
      case "tmdb_id": setNum("tmdbId", value); break;
      case "imdb_id": setStr("imdbId", value); break;
      case "show": setStr("show", value); break;
      case "tmdb_show_id": setNum("tmdbShowId", value); break;
      case "season": setNum("season", value); break;
      case "starting_episode": setNum("startingEpisode", value); break;
      case "episode_order":
        setChoice("episodeOrder", value, ["broadcast", "production", "dvd"] as const);
        break;
      case "include_extras": setBool("includeExtras", value); break;
      case "min_length_skip":
        // Accepts string ("90s") or boolean false (TOML doesn't allow
        // mixed-type values, so users use the literal string "false").
        if (typeof value === "string") out.minLengthSkip = value;
        else if (value === false) out.minLengthSkip = "false";
        break;
      case "out": setStr("out", value); break;
      case "db": setStr("db", value); break;
      case "makemkvcon": setStr("makemkvcon", value); break;
      case "output_format":
        setChoice("outputFormat", value, ["plex", "flat", "jellyfin", "kodi"] as const);
        break;
      case "dry_run": setBool("dryRun", value); break;
      case "force": setBool("force", value); break;
      case "verbose": setBool("verbose", value); break;
      default:
        // Unknown keys ignored — keeps forward-compat with future flags.
        break;
    }
  }
  return out;
}

// CLI flags + later sources, where each later source overrides earlier ones
// on the keys it sets. Per §7.1 the order is:
//   1. CLI flags (already include the [defaults] from the main config)
//   2. matching batch.toml glob blocks in file order
//   3. per-disc bdremuxer.toml sidecar
export function mergeOverrides(
  base: CliOpts,
  ...layers: Array<TomlOverrides | null | undefined>
): CliOpts {
  const merged: CliOpts = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    for (const k of Object.keys(layer) as Array<keyof TomlOverrides>) {
      const v = layer[k];
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

export function resolveDiscOverrides(opts: {
  cliOpts: CliOpts;
  discRelPath: string;
  discAbsPath: string;
  batchBlocks: GlobBlock[];
}): CliOpts {
  const matching = opts.batchBlocks.filter((b) => globMatch(b.glob, opts.discRelPath));
  const sidecar = loadSidecarOverrides(opts.discAbsPath);
  return mergeOverrides(opts.cliOpts, ...matching.map((b) => b.overrides), sidecar);
}

// Type guard helper — exported for tests.
export type { EpisodeOrder, OutputFormat };
