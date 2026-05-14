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
  // Surfaces when the cohort detector found more titles than the season
  // has remaining slots (e.g. a 25-min commentary track passed the ±20%
  // duration clustering). The surplus titles are demoted to `extras` so
  // the user gets the MKVs and can re-classify by hand. `seatedAsEpisode`
  // is the cohort count *after* the trim; `detected` is before.
  cohortTrimmed?: {
    detected: number;
    seatedAsEpisode: number;
    demoted: TitleRow[];
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

  let cohortPlus = outlierIncluded ? [...cohort, outlierIncluded] : cohort;
  // Disc order = makemkv title index order.
  cohortPlus.sort((a, b) => a.makemkv_id - b.makemkv_id);
  const detectedCohortSize = cohortPlus.length;

  // Cohort overflow guard. The duration-clustering pass is permissive on
  // purpose (±20% main + ±40% outlier) so it doesn't drop short finales;
  // the price is that commentary/featurette tracks within that window
  // sneak in. If TMDB tells us the season has fewer episode slots than
  // the cohort claims, trim the tail (disc order) and demote the surplus
  // to extras so the user still gets the MKVs.
  let cohortTrimmed: TvSelection["cohortTrimmed"];
  const demotedFromCohort: TitleRow[] = [];
  if (opts.episodes.length > 0) {
    const maxEpisodeNumber = Math.max(...opts.episodes.map((e) => e.episode_number));
    const remainingSeats = maxEpisodeNumber - opts.startingEpisode + 1;
    if (remainingSeats >= 0 && cohortPlus.length > remainingSeats) {
      const tail = cohortPlus.slice(remainingSeats);
      cohortPlus = cohortPlus.slice(0, remainingSeats);
      demotedFromCohort.push(...tail);
      cohortTrimmed = {
        detected: detectedCohortSize,
        seatedAsEpisode: cohortPlus.length,
        demoted: tail,
      };
    }
  }

  // Map to episodes starting at --starting-episode.
  const byEpNum = new Map<number, EpisodeRow>();
  for (const e of opts.episodes) byEpNum.set(e.episode_number, e);

  const episodeMap: Array<{ title: TitleRow; episode: EpisodeRow }> = [];
  for (let i = 0; i < cohortPlus.length; i++) {
    const epNum = opts.startingEpisode + i;
    const episode = byEpNum.get(epNum);
    if (!episode) {
      // The cap above already ensures we don't run past `maxEpisodeNumber`;
      // a miss here means the season has a hole in its numbering (e.g.
      // TMDB lists 1, 2, 3, 5 with E04 missing). Surface the gap honestly
      // rather than silently dropping.
      throw new Error(
        `No episode ${epNum} in TMDB's listing for this season (cohort has ` +
          `${cohortPlus.length} title(s) starting at episode ` +
          `${opts.startingEpisode}). Check --starting-episode or the season's TMDB data.`,
      );
    }
    episodeMap.push({ title: cohortPlus[i]!, episode });
  }

  // Remaining survivors are extras (or skipped when --include-extras is off).
  // The cohort-demoted titles always tag along as extras even when
  // include_extras is false, because they came from the episode cohort
  // and the user almost certainly wants the bytes for triage.
  const inCohortPlus = new Set(cohortPlus);
  const inDemoted = new Set(demotedFromCohort);
  const remaining = survived.filter((t) => !inCohortPlus.has(t) && !inDemoted.has(t));
  const regularExtras = opts.includeExtras ? remaining : [];
  if (!opts.includeExtras) {
    for (const t of remaining) {
      skipped.push({ title: t, reason: "not selected (extras disabled)" });
    }
  }
  const extras = [...regularExtras, ...demotedFromCohort];

  return {
    episodeMap,
    extras,
    skipped,
    cohort: { median: cohortMedian, count: cohortPlus.length, relStdev, outlierIncluded },
    ...(cohortTrimmed ? { cohortTrimmed } : {}),
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
// Cross-disc episode-allocation conflict detection
// -----------------------------------------------------------------------
//
// When several discs in the same season share a batch.toml glob block, it's
// easy to forget per-disc `starting_episode` values — every disc then
// defaults to 1 and silently claims the same episodes. The per-title remux
// step would then skip every file on disc 2+ (because disc 1 already wrote
// them), leaving manifests that say "disc 2 has episodes 1-10" while the
// disc-2 MKVs are nowhere on disk.
//
// We catch that before any rip happens: ask the DB whether any of the
// episode IDs this disc would claim are already linked to a title on a
// *different* disc.

export type EpisodeConflict = {
  episodeId: number;
  episodeNumber: number;
  otherDiscFingerprint: string;
  otherDiscVolumeLabel: string | null;
};

export class EpisodeAllocationConflictError extends Error {
  constructor(
    readonly conflicts: EpisodeConflict[],
    readonly seasonNumber: number,
    readonly showName: string,
    readonly suggestedStartingEpisode: number | null,
  ) {
    const { label, verb } = formatEpisodeList(conflicts.map((c) => c.episodeNumber));
    const labels = Array.from(
      new Set(
        conflicts.map((c) => c.otherDiscVolumeLabel ?? c.otherDiscFingerprint.slice(0, 8)),
      ),
    ).join(", ");
    // The message describes the *fact* only. What the user should do
    // about it (set starting_episode = N, or trust init-batch to
    // auto-patch) is context-dependent and lives on the blocked-plan
    // suggestion that the caller in cli.ts builds — see planTv.
    super(
      `${label} of "${showName}" S${String(seasonNumber).padStart(2, "0")} ` +
        `${verb} already claimed by another disc (${labels}).`,
    );
  }
}

// Render a list of episode numbers as "Episode 5" (single), "Episodes
// 1-10" (consecutive run), or "Episodes 1, 3, 5" (non-consecutive
// fallback). Returns the matching subject + auxiliary verb so the
// surrounding sentence stays grammatical: "is" vs "are".
function formatEpisodeList(numbers: number[]): { label: string; verb: "is" | "are" } {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return { label: "No episodes", verb: "are" };
  if (sorted.length === 1) return { label: `Episode ${sorted[0]}`, verb: "is" };
  let consecutive = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! !== sorted[i - 1]! + 1) {
      consecutive = false;
      break;
    }
  }
  if (consecutive) {
    return {
      label: `Episodes ${sorted[0]}-${sorted[sorted.length - 1]}`,
      verb: "are",
    };
  }
  return { label: `Episodes ${sorted.join(", ")}`, verb: "are" };
}

export function findEpisodeAllocationConflicts(
  db: DB,
  currentDiscId: number,
  candidateEpisodeIds: number[],
): EpisodeConflict[] {
  if (candidateEpisodeIds.length === 0) return [];
  const placeholders = candidateEpisodeIds.map(() => "?").join(",");
  const rows = db
    .query<
      {
        episode_id: number;
        episode_number: number;
        fingerprint: string;
        volume_label: string | null;
      },
      (number | string)[]
    >(
      `SELECT t.episode_id AS episode_id,
              e.episode_number AS episode_number,
              d.fingerprint AS fingerprint,
              d.volume_label AS volume_label
       FROM title t
       JOIN episode e ON e.id = t.episode_id
       JOIN disc d ON d.id = t.disc_id
       WHERE t.episode_id IN (${placeholders})
         AND t.disc_id != ?`,
    )
    .all(...candidateEpisodeIds, currentDiscId);
  return rows.map((r) => ({
    episodeId: r.episode_id,
    episodeNumber: r.episode_number,
    otherDiscFingerprint: r.fingerprint,
    otherDiscVolumeLabel: r.volume_label,
  }));
}

// Returns the highest episode_number currently claimed in `seasonId` by any
// other disc, so the orchestrator can suggest `starting_episode = N + 1` in
// the conflict error message. Returns null when nothing is claimed yet.
export function highestClaimedEpisodeInSeason(
  db: DB,
  seasonId: number,
  excludeDiscId: number,
): number | null {
  const row = db
    .query<{ max_ep: number | null }, [number, number]>(
      `SELECT MAX(e.episode_number) AS max_ep
       FROM title t
       JOIN episode e ON e.id = t.episode_id
       WHERE e.season_id = ?
         AND t.disc_id != ?`,
    )
    .get(seasonId, excludeDiscId);
  return row?.max_ep ?? null;
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
