// Integration test for the macOS ISO backend. Generates a synthetic
// Blu-ray-shaped ISO via `hdiutil makehybrid`, opens it through the
// DiscSource factory, asserts the BDMV is reachable, closes the source,
// and asserts the mount is gone.
//
// Skipped on non-darwin (the backend itself throws there).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDiscSource } from "../src/disc/index.ts";

const isMacOS = process.platform === "darwin";
const describeMac = isMacOS ? describe : describe.skip;

async function makeBlankBdIso(): Promise<{ isoPath: string; workspace: string }> {
  const workspace = mkdtempSync(join(tmpdir(), "bdremuxer-iso-test-"));
  const stub = join(workspace, "stub");
  mkdirSync(join(stub, "BDMV", "STREAM"), { recursive: true });
  writeFileSync(join(stub, "BDMV", "index.bdmv"), "fake-bdmv");
  // One tiny m2ts so the scan/fingerprint code has something to hash.
  writeFileSync(join(stub, "BDMV", "STREAM", "00000.m2ts"), Buffer.alloc(1024));

  const isoPath = join(workspace, "blank.iso");
  const proc = Bun.spawn(
    [
      "hdiutil",
      "makehybrid",
      "-iso",
      "-udf",
      "-udf-volume-name",
      "BDFAKE",
      "-o",
      isoPath,
      stub,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`hdiutil makehybrid failed (${code}): ${stderr}`);
  }
  return { isoPath, workspace };
}

describeMac("openDiscSource with .iso input on macOS", () => {
  test("mounts the ISO, exposes the BDMV path, and detaches on close", async () => {
    const { isoPath, workspace } = await makeBlankBdIso();
    const mountRoot = join(workspace, ".bdremuxer", "mounts");

    let mountPointSeen: string | null = null;
    try {
      const source = await openDiscSource(isoPath, {
        mountRoot,
        log: () => {},
      });

      expect(source.kind).toBe("iso");
      expect(source.originalPath).toBe(isoPath);
      expect(source.label).toBe("blank");
      mountPointSeen = source.bdmvPath;

      // BDMV/index.bdmv must be readable through the mount.
      const indexStat = statSync(join(source.bdmvPath, "BDMV", "index.bdmv"));
      expect(indexStat.isFile()).toBe(true);

      await source.close();

      // After close, the mount point should no longer exist as a
      // mounted directory. hdiutil also removes the dsk-random dir.
      let stillThere = false;
      try {
        statSync(mountPointSeen);
        stillThere = true;
      } catch {
        // expected: gone
      }
      expect(stillThere).toBe(false);

      // Double-close is a no-op (idempotent close contract).
      await source.close();
    } finally {
      // Belt-and-braces cleanup if anything above threw mid-test.
      if (mountPointSeen) {
        try {
          Bun.spawnSync(["hdiutil", "detach", "-force", mountPointSeen]);
        } catch {}
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
