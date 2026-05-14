// §5.1 Scan: compute disc fingerprint, record/refresh a `disc` row.

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DB, DiscRow, DiscStatus } from "../db.ts";
import type { DiscSource } from "../disc/index.ts";

export type ScanResult = {
  fingerprint: string;
  volumeLabel: string;
  disc: DiscRow;
};

export async function scan(db: DB, source: DiscSource): Promise<ScanResult> {
  const fingerprint = await computeFingerprint(source.bdmvPath);
  const volumeLabel = source.label || null;
  const disc = upsertDisc(db, {
    fingerprint,
    sourcePath: source.originalPath,
    volumeLabel,
  });
  return { fingerprint, volumeLabel: volumeLabel ?? "", disc };
}

async function computeFingerprint(bdmvDir: string): Promise<string> {
  const indexBdmv = join(bdmvDir, "BDMV", "index.bdmv");
  const indexBytes = new Uint8Array(await Bun.file(indexBdmv).arrayBuffer());

  const m2ts = listM2ts(join(bdmvDir, "BDMV"));
  m2ts.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const h = createHash("sha256");
  h.update(indexBytes);
  for (const e of m2ts) h.update(`\n${e.relPath}=${e.size}`);
  return h.digest("hex");
}

function listM2ts(root: string): Array<{ relPath: string; size: number }> {
  const out: Array<{ relPath: string; size: number }> = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const sub = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, sub);
      else if (ent.isFile() && /\.m2ts$/i.test(ent.name)) {
        out.push({ relPath: sub, size: statSync(abs).size });
      }
    }
  };
  walk(root, "");
  return out;
}

// At scan time we don't know if the disc is a movie or a TV box-set —
// classification (§5.3) needs probe data. Tentatively insert as 'movie';
// classify will UPDATE if it decides 'tv'. This keeps media_kind NOT NULL
// per spec §8 without needing a placeholder enum value.
function upsertDisc(
  db: DB,
  opts: { fingerprint: string; sourcePath: string; volumeLabel: string | null },
): DiscRow {
  const now = new Date().toISOString();

  const existing = db
    .query<DiscRow, [string]>(`SELECT * FROM disc WHERE fingerprint = ?`)
    .get(opts.fingerprint);

  if (existing) {
    // Preserve a previously-completed status so the orchestrator's
    // `status === 'done'` early-out can fire on re-runs. Any non-terminal
    // status gets rewound to 'scanned' — the pipeline will march it forward
    // again as each stage's persist call updates it.
    const nextStatus: DiscStatus = existing.status === "done" ? "done" : "scanned";
    db.run(
      `UPDATE disc
       SET source_path = ?, volume_label = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [opts.sourcePath, opts.volumeLabel, nextStatus, now, existing.id],
    );
    return {
      ...existing,
      source_path: opts.sourcePath,
      volume_label: opts.volumeLabel,
      status: nextStatus,
    };
  }

  const inserted = db
    .query<DiscRow, [string, string, string | null, string, string]>(
      `INSERT INTO disc
         (fingerprint, source_path, volume_label, media_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'movie', 'scanned', ?, ?)
       RETURNING *`,
    )
    .get(opts.fingerprint, opts.sourcePath, opts.volumeLabel, now, now);
  if (!inserted) throw new Error("Failed to insert disc row");
  return inserted;
}
