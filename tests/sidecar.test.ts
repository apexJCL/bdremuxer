// Tests for `loadSidecarOverrides` — the per-disc TOML override loader.
// Folder-backed discs use `<disc>/bdremuxer.toml`; ISO discs use a
// disambiguated naming scheme so multiple ISOs in the same parent dir
// don't accidentally share a sidecar (specs/spec-iso.md §7).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSidecarOverrides } from "../src/batch.ts";

function inTmp(name: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `bdremuxer-sidecar-${name}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeIso(parent: string, filename: string): string {
  const p = join(parent, filename);
  writeFileSync(p, "");
  return p;
}

function makeBdmvDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, "BDMV"), { recursive: true });
  writeFileSync(join(dir, "BDMV", "index.bdmv"), "fake");
  return dir;
}

describe("loadSidecarOverrides — folder-backed disc", () => {
  test("reads <disc>/bdremuxer.toml", () => {
    const { dir, cleanup } = inTmp("folder");
    try {
      const disc = makeBdmvDir(dir, "DISC_A");
      writeFileSync(
        join(disc, "bdremuxer.toml"),
        `type = "tv"\nshow = "Breaking Bad (2008)"\nseason = 2\n`,
      );
      const ov = loadSidecarOverrides(disc);
      expect(ov?.type).toBe("tv");
      expect(ov?.show).toBe("Breaking Bad (2008)");
      expect(ov?.season).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("returns null when there is no sidecar", () => {
    const { dir, cleanup } = inTmp("folder-none");
    try {
      const disc = makeBdmvDir(dir, "DISC_A");
      expect(loadSidecarOverrides(disc)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("loadSidecarOverrides — ISO disc", () => {
  test("reads the disambiguated <basename>.bdremuxer.toml next to the ISO", () => {
    const { dir, cleanup } = inTmp("iso-named");
    try {
      const iso = makeIso(dir, "MY_DISC.iso");
      writeFileSync(
        join(dir, "MY_DISC.bdremuxer.toml"),
        `type = "movie"\ntitle = "The Thing (1982)"\n`,
      );
      const ov = loadSidecarOverrides(iso);
      expect(ov?.type).toBe("movie");
      expect(ov?.title).toBe("The Thing (1982)");
    } finally {
      cleanup();
    }
  });

  test("named sidecar wins over bare bdremuxer.toml", () => {
    const { dir, cleanup } = inTmp("iso-priority");
    try {
      const iso = makeIso(dir, "MY_DISC.iso");
      writeFileSync(join(dir, "MY_DISC.bdremuxer.toml"), `season = 3\n`);
      writeFileSync(join(dir, "bdremuxer.toml"), `season = 99\n`);
      const ov = loadSidecarOverrides(iso);
      expect(ov?.season).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("falls back to bare bdremuxer.toml when the ISO is alone in its parent", () => {
    const { dir, cleanup } = inTmp("iso-alone");
    try {
      const iso = makeIso(dir, "MY_DISC.iso");
      writeFileSync(join(dir, "bdremuxer.toml"), `type = "movie"\n`);
      const ov = loadSidecarOverrides(iso);
      expect(ov?.type).toBe("movie");
    } finally {
      cleanup();
    }
  });

  test("does NOT use bare bdremuxer.toml when sibling ISOs exist", () => {
    const { dir, cleanup } = inTmp("iso-siblings");
    try {
      const iso = makeIso(dir, "MY_DISC.iso");
      makeIso(dir, "OTHER.iso");
      writeFileSync(join(dir, "bdremuxer.toml"), `type = "movie"\n`);
      // Bare bdremuxer.toml is ambiguous when multiple ISOs share the
      // parent — the loader must skip it to avoid leaking onto siblings.
      expect(loadSidecarOverrides(iso)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("each ISO can still own its own named sidecar in a multi-ISO parent", () => {
    const { dir, cleanup } = inTmp("iso-each-named");
    try {
      const isoA = makeIso(dir, "DISC_A.iso");
      makeIso(dir, "DISC_B.iso");
      writeFileSync(join(dir, "DISC_A.bdremuxer.toml"), `season = 1\n`);
      writeFileSync(join(dir, "DISC_B.bdremuxer.toml"), `season = 2\n`);
      expect(loadSidecarOverrides(isoA)?.season).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("strips the .iso extension case-insensitively", () => {
    const { dir, cleanup } = inTmp("iso-case");
    try {
      const iso = makeIso(dir, "DiscX.ISO");
      writeFileSync(join(dir, "DiscX.bdremuxer.toml"), `season = 7\n`);
      const ov = loadSidecarOverrides(iso);
      expect(ov?.season).toBe(7);
    } finally {
      cleanup();
    }
  });

  test("returns null when neither named nor bare sidecar exists", () => {
    const { dir, cleanup } = inTmp("iso-none");
    try {
      const iso = makeIso(dir, "MY_DISC.iso");
      expect(loadSidecarOverrides(iso)).toBeNull();
    } finally {
      cleanup();
    }
  });
});
