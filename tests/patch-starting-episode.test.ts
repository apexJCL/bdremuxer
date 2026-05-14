// init-batch's TOML auto-patcher. After the wizard writes a TOML where
// every per-disc block has `starting_episode = 1` as a placeholder, the
// preflight pass identifies the right values (via the
// EpisodeAllocationConflict guard's structured `fix`) and the patcher
// writes them back in place. Comments and surrounding lines must survive.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { patchStartingEpisodes } from "../src/init-batch.ts";

function writeFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bdremuxer-patch-"));
  const path = join(dir, "bdremuxer.batch.toml");
  writeFileSync(path, contents);
  return path;
}

const TOML = `# bdremuxer batch override file
["SHOW_S1_HDBEE/S1 D*"]
type = "tv"
show = "Show Name"
season = 1
tmdb_show_id = 12345

# Disc 1 of 2 in "Show Name - S1".
["SHOW_S1_HDBEE/S1 D1"]
starting_episode = 1

# Disc 2 of 2 in "Show Name - S1".
# TODO: set starting_episode to the first episode number on this disc.
["SHOW_S1_HDBEE/S1 D2"]
starting_episode = 1
`;

describe("patchStartingEpisodes", () => {
  test("rewrites starting_episode within the matching block only", () => {
    const path = writeFixture(TOML);
    const r = patchStartingEpisodes(path, [
      { relPath: "SHOW_S1_HDBEE/S1 D2", startingEpisode: 14 },
    ]);
    expect(r.patched).toEqual(["SHOW_S1_HDBEE/S1 D2"]);
    expect(r.unpatched).toEqual([]);
    const updated = readFileSync(path, "utf8");
    // D2's value flipped to 14.
    expect(updated).toContain(`["SHOW_S1_HDBEE/S1 D2"]\nstarting_episode = 14`);
    // D1 untouched.
    expect(updated).toContain(`["SHOW_S1_HDBEE/S1 D1"]\nstarting_episode = 1`);
    // Comments preserved.
    expect(updated).toContain(`# Disc 1 of 2 in "Show Name - S1".`);
    expect(updated).toContain(`# Disc 2 of 2 in "Show Name - S1".`);
    expect(updated).toContain(`# TODO: set starting_episode to the first episode number on this disc.`);
    // Group glob block survives.
    expect(updated).toContain(`tmdb_show_id = 12345`);
  });

  test("multi-disc patches apply independently in one pass", () => {
    const wide = TOML +
      `\n["SHOW_S2_HDBEE/S2 D2"]\nstarting_episode = 1\n`;
    const path = writeFixture(wide);
    const r = patchStartingEpisodes(path, [
      { relPath: "SHOW_S1_HDBEE/S1 D2", startingEpisode: 14 },
      { relPath: "SHOW_S2_HDBEE/S2 D2", startingEpisode: 13 },
    ]);
    expect(r.patched.sort()).toEqual([
      "SHOW_S1_HDBEE/S1 D2",
      "SHOW_S2_HDBEE/S2 D2",
    ]);
    const updated = readFileSync(path, "utf8");
    expect(updated).toContain(`["SHOW_S1_HDBEE/S1 D2"]\nstarting_episode = 14`);
    expect(updated).toContain(`["SHOW_S2_HDBEE/S2 D2"]\nstarting_episode = 13`);
  });

  test("missing block ends up in unpatched, file unchanged", () => {
    const path = writeFixture(TOML);
    const before = readFileSync(path, "utf8");
    const r = patchStartingEpisodes(path, [
      { relPath: "NONEXISTENT_DISC", startingEpisode: 99 },
    ]);
    expect(r.patched).toEqual([]);
    expect(r.unpatched).toHaveLength(1);
    expect(r.unpatched[0]?.relPath).toBe("NONEXISTENT_DISC");
    // File untouched (we don't writeFileSync when nothing patched).
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("block exists but has no starting_episode key — left alone", () => {
    // The group glob block (e.g. `["SHOW_S1_HDBEE/S1 D*"]`) doesn't
    // carry a starting_episode line. Patching it should no-op rather
    // than accidentally writing one to a sibling block.
    const path = writeFixture(TOML);
    const r = patchStartingEpisodes(path, [
      { relPath: "SHOW_S1_HDBEE/S1 D*", startingEpisode: 99 },
    ]);
    expect(r.patched).toEqual([]);
    expect(r.unpatched).toHaveLength(1);
    // D1 and D2 must remain at 1 — the patcher must not have wandered
    // into them looking for a starting_episode line.
    const updated = readFileSync(path, "utf8");
    expect(updated).toContain(`["SHOW_S1_HDBEE/S1 D1"]\nstarting_episode = 1`);
    expect(updated).toContain(`["SHOW_S1_HDBEE/S1 D2"]\nstarting_episode = 1`);
  });

  test("empty patch list is a cheap no-op", () => {
    const path = writeFixture(TOML);
    const r = patchStartingEpisodes(path, []);
    expect(r).toEqual({ patched: [], unpatched: [] });
    expect(readFileSync(path, "utf8")).toBe(TOML);
  });
});
