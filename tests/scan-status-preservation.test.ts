// Re-running `scan` over a previously-completed disc must leave
// `disc.status='done'` intact so the orchestrator's "already done"
// early-out at cli.ts:330 can actually fire. Before this fix scan
// unconditionally rewrote status to 'scanned', making that early-out
// unreachable.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.ts";
import { openBdmvDirSource } from "../src/disc/index.ts";
import { scan } from "../src/pipeline/scan.ts";

function makeFakeDisc(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `bdremuxer-${label}-`));
  mkdirSync(join(root, "BDMV"), { recursive: true });
  // index.bdmv is the only file scan strictly requires to compute a
  // fingerprint. The m2ts list may be empty.
  writeFileSync(join(root, "BDMV", "index.bdmv"), Buffer.from(`fake-${label}`));
  return root;
}

describe("scan re-run status handling", () => {
  test("a previously-done disc stays 'done' after re-scan", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "bdremuxer-scan-db-")), "test.sqlite");
    const db = openDb(dbPath);
    const discRoot = makeFakeDisc("DONE");

    const first = await scan(db, openBdmvDirSource(discRoot));

    // Pretend the pipeline reached the end.
    db.run(`UPDATE disc SET status = 'done' WHERE id = ?`, [first.disc.id]);

    const second = await scan(db, openBdmvDirSource(discRoot));
    expect(second.disc.id).toBe(first.disc.id);
    expect(second.disc.status).toBe("done");

    // And it's persisted, not just returned in-memory.
    const row = db
      .query<{ status: string }, [number]>(`SELECT status FROM disc WHERE id = ?`)
      .get(first.disc.id);
    expect(row?.status).toBe("done");
  });

  test("non-terminal statuses get rewound to 'scanned' on re-scan", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "bdremuxer-scan-db-")), "test.sqlite");
    const db = openDb(dbPath);
    const discRoot = makeFakeDisc("CLASSIFIED");

    const first = await scan(db, openBdmvDirSource(discRoot));
    db.run(`UPDATE disc SET status = 'classified' WHERE id = ?`, [first.disc.id]);

    const second = await scan(db, openBdmvDirSource(discRoot));
    expect(second.disc.status).toBe("scanned");
  });
});
