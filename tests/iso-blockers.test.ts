// Tests for the preflight blocker classification of ISO open errors.
//
// Three layers covered here:
//   1. Unit: classifyDiscOpenError maps each error type to its code +
//      suggestion. Platform-agnostic.
//   2. Integration: openDiscSource raises IsoMountError for a non-ISO
//      file with a .iso extension. macOS-gated.
//   3. Integration: openDiscSource raises NoBdmvInIsoError when the
//      mounted ISO has no BDMV/index.bdmv inside. macOS-gated.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyDiscOpenError,
  IsoMountError,
  NoBdmvInIsoError,
  openDiscSource,
} from "../src/disc/index.ts";

const isMacOS = process.platform === "darwin";
const describeMac = isMacOS ? describe : describe.skip;

describe("classifyDiscOpenError", () => {
  test("categorises IsoMountError → iso_mount_failed", () => {
    const res = classifyDiscOpenError(new IsoMountError("hdiutil exit 1", "/x.iso"));
    expect(res.code).toBe("iso_mount_failed");
    expect(res.suggestion).toBeDefined();
    expect(res.suggestion!.length).toBeGreaterThan(0);
  });

  test("categorises NoBdmvInIsoError → iso_no_bdmv", () => {
    const res = classifyDiscOpenError(new NoBdmvInIsoError("no bdmv", "/x.iso"));
    expect(res.code).toBe("iso_no_bdmv");
    expect(res.suggestion).toBeDefined();
  });

  test("leaves generic errors unclassified", () => {
    expect(classifyDiscOpenError(new Error("kaboom")).code).toBeUndefined();
    expect(classifyDiscOpenError(null).code).toBeUndefined();
    expect(classifyDiscOpenError(undefined).code).toBeUndefined();
  });
});

describeMac("openDiscSource ISO failure modes", () => {
  test("zero-byte .iso file → IsoMountError", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bdremuxer-iso-bogus-"));
    try {
      const iso = join(tmp, "bogus.iso");
      writeFileSync(iso, "");
      let captured: unknown;
      try {
        await openDiscSource(iso, {
          mountRoot: join(tmp, ".bdremuxer", "mounts"),
          log: () => {},
        });
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(IsoMountError);
      const { code } = classifyDiscOpenError(captured);
      expect(code).toBe("iso_mount_failed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  test("valid ISO with no BDMV inside → NoBdmvInIsoError", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bdremuxer-iso-nobdmv-"));
    try {
      const stub = join(tmp, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "README.txt"), "not a blu-ray disc");

      const iso = join(tmp, "nobdmv.iso");
      const make = Bun.spawn(
        [
          "hdiutil",
          "makehybrid",
          "-iso",
          "-udf",
          "-udf-volume-name",
          "NOBD",
          "-o",
          iso,
          stub,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await new Response(make.stdout).text();
      const makeErr = await new Response(make.stderr).text();
      const makeCode = await make.exited;
      if (makeCode !== 0) throw new Error(`hdiutil makehybrid failed: ${makeErr}`);

      let captured: unknown;
      try {
        await openDiscSource(iso, {
          mountRoot: join(tmp, ".bdremuxer", "mounts"),
          log: () => {},
        });
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(NoBdmvInIsoError);
      const { code } = classifyDiscOpenError(captured);
      expect(code).toBe("iso_no_bdmv");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
