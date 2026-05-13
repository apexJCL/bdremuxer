// Run-table helpers (§8). One row per `bdremuxer <disc>` invocation.

import type { DB, DiscStatus } from "../db.ts";

export function startRun(db: DB, discId: number): number {
  const row = db
    .query<{ id: number }, [number, string]>(
      `INSERT INTO run (disc_id, started_at) VALUES (?, ?) RETURNING id`,
    )
    .get(discId, new Date().toISOString());
  if (!row) throw new Error("Failed to insert run row");
  return row.id;
}

export function setRunLogPath(db: DB, runId: number, logPath: string): void {
  db.run(`UPDATE run SET log_path = ? WHERE id = ?`, [logPath, runId]);
}

export function finishRun(db: DB, runId: number, ok: boolean): void {
  db.run(`UPDATE run SET finished_at = ?, ok = ? WHERE id = ?`, [
    new Date().toISOString(),
    ok ? 1 : 0,
    runId,
  ]);
}

export function markDiscFailed(
  db: DB,
  discId: number,
  failedAtStage: DiscStatus,
): void {
  db.run(
    `UPDATE disc SET status = 'failed', failed_at_stage = ?, updated_at = ?
     WHERE id = ?`,
    [failedAtStage, new Date().toISOString(), discId],
  );
}
