// Tests for the NDJSON event surface around ISO mounts (specs/spec-iso.md
// §10). The CLI wires `DiscSourceContext.emitEvent` to its `emitJson`
// helper under `--json`; here we capture events into an array and assert
// the kind+payload sequence.
//
// macOS-gated because the real mount lifecycle is what fires these events.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDiscSource } from "../src/disc/index.ts";

const isMacOS = process.platform === "darwin";
const describeMac = isMacOS ? describe : describe.skip;

type Event = { kind: string; data: Record<string, unknown> };

async function makeBlankBdIso(workspace: string, leafName = "blank.iso"): Promise<string> {
  const stub = join(workspace, "stub");
  mkdirSync(join(stub, "BDMV", "STREAM"), { recursive: true });
  writeFileSync(join(stub, "BDMV", "index.bdmv"), "fake-bdmv");
  writeFileSync(join(stub, "BDMV", "STREAM", "00000.m2ts"), Buffer.alloc(1024));

  const isoPath = join(workspace, leafName);
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
  if ((await proc.exited) !== 0) throw new Error(`makehybrid failed: ${stderr}`);
  return isoPath;
}

describeMac("ISO JSON events", () => {
  test("emits iso_attach_start → iso_attached → iso_detach across the source lifecycle", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bdremuxer-events-"));
    try {
      const isoPath = await makeBlankBdIso(workspace);
      const events: Event[] = [];

      const source = await openDiscSource(isoPath, {
        mountRoot: join(workspace, ".bdremuxer", "mounts"),
        log: () => {},
        emitEvent: (kind, data) => events.push({ kind, data }),
      });

      // After attach: two events, in order.
      expect(events.map((e) => e.kind)).toEqual(["iso_attach_start", "iso_attached"]);
      expect(events[0]!.data).toEqual({ iso_path: isoPath });
      expect(events[1]!.data["iso_path"]).toBe(isoPath);
      expect(events[1]!.data["mount_point"]).toBe(source.bdmvPath);

      await source.close();

      // After close: one more event, with ok=true on a clean detach.
      expect(events).toHaveLength(3);
      expect(events[2]!.kind).toBe("iso_detach");
      expect(events[2]!.data["iso_path"]).toBe(isoPath);
      expect(events[2]!.data["mount_point"]).toBe(source.bdmvPath);
      expect(events[2]!.data["ok"]).toBe(true);

      // Idempotent close: no extra events.
      await source.close();
      expect(events).toHaveLength(3);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  test("non-ISO discs emit no iso_* events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bdremuxer-events-dir-"));
    try {
      const discRoot = join(workspace, "DISC");
      mkdirSync(join(discRoot, "BDMV"), { recursive: true });
      writeFileSync(join(discRoot, "BDMV", "index.bdmv"), "fake");

      const events: Event[] = [];
      const source = await openDiscSource(discRoot, {
        mountRoot: join(workspace, ".bdremuxer", "mounts"),
        log: () => {},
        emitEvent: (kind, data) => events.push({ kind, data }),
      });
      await source.close();

      expect(events.filter((e) => e.kind.startsWith("iso_"))).toHaveLength(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
