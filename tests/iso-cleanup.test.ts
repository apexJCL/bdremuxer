// Tests for `cleanupStrandedMounts`. The full "still-mounted" path is
// exercised by tests/iso-mount.test.ts; here we cover the cheaper
// branches that can be tested without an actual hdiutil mount.
//
// macOS-gated because the implementation depends on `mount` output
// shape and `hdiutil`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetStrandedCleanupForTests,
  cleanupStrandedMounts,
} from "../src/disc/iso-macos.ts";

const isMacOS = process.platform === "darwin";
const describeMac = isMacOS ? describe : describe.skip;

describeMac("cleanupStrandedMounts", () => {
  beforeEach(() => {
    _resetStrandedCleanupForTests();
  });
  afterEach(() => {
    _resetStrandedCleanupForTests();
  });

  test("is a no-op when mountRoot doesn't exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bdremuxer-cleanup-"));
    try {
      const ghost = join(tmp, "never-created", ".bdremuxer", "mounts");
      // Should not throw, should not create the dir.
      await cleanupStrandedMounts(ghost, () => {});
      expect(existsSync(ghost)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("removes an empty stale dir under mountRoot", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bdremuxer-cleanup-"));
    try {
      const mountRoot = join(tmp, ".bdremuxer", "mounts");
      const stale = join(mountRoot, "dsk-stale");
      mkdirSync(stale, { recursive: true });
      // The dir isn't in the live mount table, so cleanup should rmdir it.
      await cleanupStrandedMounts(mountRoot, () => {});
      expect(existsSync(stale)).toBe(false);
      // mountRoot itself stays — we only sweep its children.
      expect(statSync(mountRoot).isDirectory()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("leaves non-empty stale dirs alone (rmdir would fail)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bdremuxer-cleanup-"));
    try {
      const mountRoot = join(tmp, ".bdremuxer", "mounts");
      const stale = join(mountRoot, "dsk-with-junk");
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, "leftover.txt"), "");
      // rmdir fails on a non-empty dir; cleanup should swallow that and
      // move on rather than crash.
      await cleanupStrandedMounts(mountRoot, () => {});
      expect(existsSync(stale)).toBe(true);
      expect(existsSync(join(stale, "leftover.txt"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("is idempotent: second call is a no-op", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bdremuxer-cleanup-"));
    try {
      const mountRoot = join(tmp, ".bdremuxer", "mounts");
      mkdirSync(join(mountRoot, "dsk-stale"), { recursive: true });

      const logged: string[] = [];
      await cleanupStrandedMounts(mountRoot, (m) => logged.push(m));
      const callsAfterFirst = logged.length;

      // Recreate a stale dir; a second call must NOT touch it because
      // the module-global flag short-circuits. (This is what makes the
      // function safe to call from per-disc loops in batch mode.)
      mkdirSync(join(mountRoot, "dsk-stale-2"), { recursive: true });
      await cleanupStrandedMounts(mountRoot, (m) => logged.push(m));
      expect(logged.length).toBe(callsAfterFirst);
      expect(existsSync(join(mountRoot, "dsk-stale-2"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
