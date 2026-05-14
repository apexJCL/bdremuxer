// Tests for `walkBdmvFolders`. Covers folder-only trees (pre-M12
// behaviour) and trees with ISO files (M12).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkBdmvFolders } from "../src/batch.ts";

function makeBdmvDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, "BDMV"), { recursive: true });
  writeFileSync(join(dir, "BDMV", "index.bdmv"), "fake");
  return dir;
}

function makeIso(parent: string, filename: string): string {
  const p = join(parent, filename);
  mkdirSync(parent, { recursive: true });
  // Not a real ISO; the walker only checks the file name + that it's a
  // regular file. Mount-time validation happens later in openDiscSource.
  writeFileSync(p, "");
  return p;
}

describe("walkBdmvFolders", () => {
  test("finds bare BDMV folders (pre-M12 behaviour)", () => {
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      makeBdmvDir(root, "DISC_A");
      makeBdmvDir(root, "DISC_B");

      const found = walkBdmvFolders(root);
      expect(found.map((d) => d.relPath)).toEqual(["DISC_A", "DISC_B"]);
      expect(found.every((d) => d.kind === "bdmv-dir")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finds .iso files as disc entries", () => {
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      makeIso(root, "MOVIE_A.iso");
      makeIso(root, "MOVIE_B.iso");

      const found = walkBdmvFolders(root);
      expect(found.map((d) => d.relPath)).toEqual(["MOVIE_A.iso", "MOVIE_B.iso"]);
      expect(found.every((d) => d.kind === "iso")).toBe(true);
      // absPath for an ISO is the .iso file itself, not its parent dir.
      expect(found[0]!.absPath.endsWith("/MOVIE_A.iso")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mixed tree: ISO + folder discs at the same level both appear", () => {
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      makeBdmvDir(root, "FOLDER_DISC");
      makeIso(root, "ISO_DISC.iso");

      const found = walkBdmvFolders(root);
      expect(found.map((d) => `${d.kind}:${d.relPath}`)).toEqual([
        "bdmv-dir:FOLDER_DISC",
        "iso:ISO_DISC.iso",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ISO files inside a non-disc folder are reached via descent", () => {
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      const movies = join(root, "Movies");
      mkdirSync(movies, { recursive: true });
      makeIso(movies, "The Thing.iso");
      makeBdmvDir(join(root, "TV", "BreakingBad_S1D1"), "");
      // makeBdmvDir given empty name creates BDMV at that dir directly.

      const found = walkBdmvFolders(root);
      expect(found.map((d) => `${d.kind}:${d.relPath}`).sort()).toEqual(
        [
          "bdmv-dir:TV/BreakingBad_S1D1",
          "iso:Movies/The Thing.iso",
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ISO files inside a disc-root folder are not double-discovered", () => {
    // If somehow an .iso sits inside a directory that itself is a BDMV
    // disc root, the walker should record the disc root and stop —
    // not descend into BDMV/ looking for ISOs.
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      const discDir = makeBdmvDir(root, "DISC");
      writeFileSync(join(discDir, "extras.iso"), ""); // inside the disc dir, not BDMV/

      const found = walkBdmvFolders(root);
      // The disc itself is the entry; we don't continue past it to find
      // the stray extras.iso. (See walker: disc-root short-circuits.)
      expect(found).toHaveLength(1);
      expect(found[0]!.kind).toBe("bdmv-dir");
      expect(found[0]!.relPath).toBe("DISC");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".bdremuxer / dotfile dirs are skipped during descent", () => {
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      // A bogus iso inside .bdremuxer must not be found.
      const internal = join(root, ".bdremuxer", "mounts");
      mkdirSync(internal, { recursive: true });
      writeFileSync(join(internal, "leftover.iso"), "");

      makeIso(root, "VISIBLE.iso");

      const found = walkBdmvFolders(root);
      expect(found.map((d) => d.relPath)).toEqual(["VISIBLE.iso"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sort order is stable across kinds", () => {
    const root = mkdtempSync(join(tmpdir(), "bdremuxer-walker-"));
    try {
      makeBdmvDir(root, "B_FOLDER");
      makeIso(root, "A_ISO.iso");
      makeBdmvDir(root, "C_FOLDER");
      makeIso(root, "D_ISO.iso");

      const found = walkBdmvFolders(root);
      expect(found.map((d) => d.relPath)).toEqual([
        "A_ISO.iso",
        "B_FOLDER",
        "C_FOLDER",
        "D_ISO.iso",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
