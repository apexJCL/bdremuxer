// §5.2 Probe: turn the parsed makemkvcon `info` output into title/track rows.

import type { DB, TitleRow } from "../db.ts";
import { SINFO, TINFO } from "../makemkv/codes.ts";
import type { ProbeResult } from "../makemkv/robot.ts";
import { parseHmsToSeconds } from "../parse/duration.ts";

export function persistProbe(db: DB, discId: number, probe: ProbeResult): TitleRow[] {
  // Re-runs clear any prior title/track rows for this disc so we don't
  // accumulate stale data if MakeMKV reports a slightly different list.
  db.run(`DELETE FROM title WHERE disc_id = ?`, [discId]);

  const insertTitle = db.query<TitleRow, [number, number, number, number, string | null]>(
    `INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, segment_map)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const insertTrack = db.query<
    null,
    [number, string, string | null, string | null, number | null, string | null]
  >(
    `INSERT INTO track (title_id, kind, codec, language, channels, flags)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const rows: TitleRow[] = [];
  const titleIdxs = [...probe.titles.keys()].sort((a, b) => a - b);
  for (const idx of titleIdxs) {
    const t = probe.titles.get(idx)!;
    const durStr = t.info.get(TINFO.DURATION) ?? "";
    const dur = parseHmsToSeconds(durStr);
    const bytes = Number(t.info.get(TINFO.SIZE_BYTES) ?? 0) || 0;
    const segs = t.info.get(TINFO.SEGMENT_MAP) ?? null;

    const row = insertTitle.get(discId, idx, dur, bytes, segs);
    if (!row) throw new Error(`Failed to insert title ${idx}`);
    rows.push(row);

    const streamIdxs = [...t.streams.keys()].sort((a, b) => a - b);
    for (const sIdx of streamIdxs) {
      const s = t.streams.get(sIdx)!;
      const channels = Number(s.get(SINFO.CHANNELS) ?? 0);
      insertTrack.run(
        row.id,
        s.get(SINFO.TYPE) ?? "?",
        s.get(SINFO.CODEC_LONG) ?? s.get(SINFO.CODEC_SHORT) ?? null,
        s.get(SINFO.LANG_CODE) ?? null,
        Number.isFinite(channels) && channels > 0 ? channels : null,
        s.get(SINFO.MKV_FLAGS_TEXT) ?? null,
      );
    }
  }

  db.run(`UPDATE disc SET status = 'probed', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    discId,
  ]);

  return rows;
}
