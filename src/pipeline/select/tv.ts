// §5.5 Select titles (TV path).
//
// 1. Pre-filter: drop titles below --min-length-skip and play-all playlists
//    (literal segment-map concat with ±2s duration check, per Q11).
// 2. Cluster surviving titles by duration; the largest cluster is the
//    episode cohort (tie-break by longest median).
// 3. Outlier inclusion (Q10): if exactly one non-cohort title is within
//    ±40% of the cohort median AND the cohort itself is tight
//    (stdev < 10% of median), pull it in — catches feature-length finales.
// 4. Map cohort titles to TMDB episodes in disc order starting at
//    --starting-episode.

import type { DB, EpisodeRow, TitleRow } from "../../db.ts";

export type TvSelectOpts = {
  titles: TitleRow[];
  episodes: EpisodeRow[];
  minLengthSkipS: number | null;
  startingEpisode: number;
  includeExtras: boolean;
};

export type TvSelection = {
  episodeMap: Array<{ title: TitleRow; episode: EpisodeRow }>;
  extras: TitleRow[];
  skipped: Array<{ title: TitleRow; reason: string }>;
  cohort: {
    median: number;
    count: number;
    relStdev: number;
    outlierIncluded: TitleRow | null;
  };
};

export function selectTv(opts: TvSelectOpts): TvSelection {
  const skipped: Array<{ title: TitleRow; reason: string }> = [];

  let survived: TitleRow[] = [];
  for (const t of opts.titles) {
    if (opts.minLengthSkipS !== null && t.duration_s < opts.minLengthSkipS) {
      skipped.push({ title: t, reason: `below min-length-skip (${opts.minLengthSkipS}s)` });
    } else {
      survived.push(t);
    }
  }

  const playAlls = new Set<TitleRow>();
  for (const t of survived) {
    if (isPlayAllOf(t, survived)) playAlls.add(t);
  }
  for (const t of playAlls) skipped.push({ title: t, reason: "play-all playlist of other titles" });
  survived = survived.filter((t) => !playAlls.has(t));

  if (survived.length === 0) {
    throw new Error("No titles remain after pre-filter; cannot detect an episode cohort.");
  }

  // Cluster by duration; pick the largest cluster, tie-break by longest median.
  const clusters = clusterByDuration(survived);
  const cohort = pickCohort(clusters);
  if (!cohort) {
    throw new Error(
      "Couldn't find an episode cohort (no group of ≥ 2 similar-duration titles). " +
        "Pass --type movie if this isn't actually a TV disc, or pass --include-extras with a movie remux instead.",
    );
  }

  const cohortMedian = medianDuration(cohort);
  const relStdev = relativeStdev(cohort, cohortMedian);

  // Outlier inclusion (Q10).
  const nonCohort = survived.filter((t) => !cohort.includes(t));
  const within40 = nonCohort.filter(
    (t) => Math.abs(t.duration_s - cohortMedian) / cohortMedian <= 0.4,
  );
  let outlierIncluded: TitleRow | null = null;
  if (within40.length === 1 && relStdev < 0.1) {
    outlierIncluded = within40[0]!;
  }

  const cohortPlus = outlierIncluded ? [...cohort, outlierIncluded] : cohort;
  // Disc order = makemkv title index order.
  cohortPlus.sort((a, b) => a.makemkv_id - b.makemkv_id);

  // Map to episodes starting at --starting-episode.
  const byEpNum = new Map<number, EpisodeRow>();
  for (const e of opts.episodes) byEpNum.set(e.episode_number, e);

  const episodeMap: Array<{ title: TitleRow; episode: EpisodeRow }> = [];
  for (let i = 0; i < cohortPlus.length; i++) {
    const epNum = opts.startingEpisode + i;
    const episode = byEpNum.get(epNum);
    if (!episode) {
      throw new Error(
        `Cohort has ${cohortPlus.length} titles mapping to episodes ` +
          `${opts.startingEpisode}-${opts.startingEpisode + cohortPlus.length - 1}, ` +
          `but the season only has episodes up to ${Math.max(...opts.episodes.map((e) => e.episode_number))}. ` +
          `Check --starting-episode or the disc's content.`,
      );
    }
    episodeMap.push({ title: cohortPlus[i]!, episode });
  }

  // Remaining survivors are extras (or skipped when --include-extras is off).
  const inCohortPlus = new Set(cohortPlus);
  const remaining = survived.filter((t) => !inCohortPlus.has(t));
  const extras = opts.includeExtras ? remaining : [];
  if (!opts.includeExtras) {
    for (const t of remaining) {
      skipped.push({ title: t, reason: "not selected (extras disabled)" });
    }
  }

  return {
    episodeMap,
    extras,
    skipped,
    cohort: { median: cohortMedian, count: cohortPlus.length, relStdev, outlierIncluded },
  };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

// Single-pass clustering: titles within ±20% of the current cluster median
// (computed incrementally) get appended; otherwise we start a new cluster.
function clusterByDuration(titles: TitleRow[]): TitleRow[][] {
  if (titles.length === 0) return [];
  const sorted = [...titles].sort((a, b) => b.duration_s - a.duration_s);
  const clusters: TitleRow[][] = [];
  let cur: TitleRow[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    const median = medianDuration(cur);
    if (median > 0 && Math.abs(t.duration_s - median) / median <= 0.2) {
      cur.push(t);
    } else {
      clusters.push(cur);
      cur = [t];
    }
  }
  clusters.push(cur);
  return clusters;
}

function pickCohort(clusters: TitleRow[][]): TitleRow[] | null {
  const candidates = clusters.filter((c) => c.length >= 2);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return medianDuration(b) - medianDuration(a);
  });
  return candidates[0]!;
}

function medianDuration(ts: TitleRow[]): number {
  const xs = ts.map((t) => t.duration_s).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[m - 1]! + xs[m]!) / 2 : xs[m]!;
}

function relativeStdev(ts: TitleRow[], mean: number): number {
  if (ts.length < 2 || mean <= 0) return 0;
  const variance = ts.reduce((acc, t) => acc + (t.duration_s - mean) ** 2, 0) / ts.length;
  return Math.sqrt(variance) / mean;
}

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

// -----------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------

export function persistTvSelection(
  db: DB,
  discId: number,
  sel: TvSelection,
): void {
  db.transaction(() => {
    db.run(`UPDATE title SET role = NULL, episode_id = NULL WHERE disc_id = ?`, [discId]);
    for (const m of sel.episodeMap) {
      db.run(`UPDATE title SET role = 'episode', episode_id = ? WHERE id = ?`, [
        m.episode.id,
        m.title.id,
      ]);
    }
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
  })();
}
