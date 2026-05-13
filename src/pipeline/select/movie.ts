// §5.5 Select titles (movie path).

import type { DB, TitleRow } from "../../db.ts";

export type MovieSelectOpts = {
  titles: TitleRow[];
  minLengthSkipS: number | null;
  tmdbRuntimeMin: number | null;
  includeExtras: boolean;
};

export type MovieSelection = {
  main: TitleRow;
  extras: TitleRow[];
  skipped: Array<{ title: TitleRow; reason: string }>;
};

export function selectMovie(opts: MovieSelectOpts): MovieSelection {
  const skipped: Array<{ title: TitleRow; reason: string }> = [];

  // Pre-filter: drop titles below the min-length threshold.
  let survived: TitleRow[] = [];
  for (const t of opts.titles) {
    if (opts.minLengthSkipS !== null && t.duration_s < opts.minLengthSkipS) {
      skipped.push({ title: t, reason: `below min-length-skip (${opts.minLengthSkipS}s)` });
    } else {
      survived.push(t);
    }
  }

  // Pre-filter: drop play-all playlists.
  const playAlls = new Set<TitleRow>();
  for (const t of survived) {
    if (isPlayAllOf(t, survived)) playAlls.add(t);
  }
  for (const t of playAlls) skipped.push({ title: t, reason: "play-all playlist of other titles" });
  survived = survived.filter((t) => !playAlls.has(t));

  if (survived.length === 0) {
    throw new Error("No titles remain after pre-filter; cannot select a main feature.");
  }

  // Main feature: longest within 90-110% of TMDB's runtime if known, else longest.
  const sorted = [...survived].sort((a, b) => b.duration_s - a.duration_s);
  let main: TitleRow | null = null;
  if (opts.tmdbRuntimeMin != null && opts.tmdbRuntimeMin > 0) {
    const target = opts.tmdbRuntimeMin * 60;
    main = sorted.find((t) => t.duration_s >= 0.9 * target && t.duration_s <= 1.1 * target) ?? null;
  }
  if (!main) main = sorted[0]!;

  const extras = opts.includeExtras ? survived.filter((t) => t !== main) : [];
  for (const t of survived) {
    if (t !== main && !extras.includes(t)) {
      skipped.push({ title: t, reason: "not selected (extras disabled)" });
    }
  }

  return { main, extras, skipped };
}

// `candidate` is a "play all" if its segments are exactly the union of two or
// more *other* titles' segments, with duration within ±2s of their sum.
// Spec §5.5 calls out that this misses non-segment-concat playlists; that's
// accepted per Q11.
function isPlayAllOf(candidate: TitleRow, all: TitleRow[]): boolean {
  if (!candidate.segment_map) return false;
  const candSegs = candidate.segment_map.split("+").filter(Boolean);
  if (candSegs.length < 2) return false;
  const candSet = new Set(candSegs);

  const consumers: TitleRow[] = [];
  let coveredSegs = 0;
  let coveredDur = 0;
  for (const t of all) {
    if (t === candidate || !t.segment_map) continue;
    const segs = t.segment_map.split("+").filter(Boolean);
    if (segs.length === 0) continue;
    if (segs.every((s) => candSet.has(s))) {
      consumers.push(t);
      coveredSegs += segs.length;
      coveredDur += t.duration_s;
    }
  }
  if (consumers.length < 2) return false;
  if (coveredSegs !== candSegs.length) return false;
  return Math.abs(coveredDur - candidate.duration_s) <= 2;
}

export function persistMovieSelection(
  db: DB,
  discId: number,
  sel: MovieSelection,
): void {
  db.run(`UPDATE title SET role = NULL, episode_id = NULL WHERE disc_id = ?`, [discId]);
  db.run(`UPDATE title SET role = 'main' WHERE id = ?`, [sel.main.id]);
  for (const t of sel.extras) {
    db.run(`UPDATE title SET role = 'extra' WHERE id = ?`, [t.id]);
  }
  for (const s of sel.skipped) {
    db.run(`UPDATE title SET role = 'skipped' WHERE id = ?`, [s.title.id]);
  }
  db.run(`UPDATE disc SET status = 'selected', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    discId,
  ]);
}
