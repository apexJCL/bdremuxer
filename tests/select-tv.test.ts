import { describe, expect, test } from "bun:test";
import { selectTv } from "../src/pipeline/select/tv.ts";
import type { EpisodeRow, TitleRow } from "../src/db.ts";

const t = (id: number, durationS: number, segMap: string | null = null): TitleRow => ({
  id,
  disc_id: 1,
  makemkv_id: id,
  duration_s: durationS,
  size_bytes: durationS * 1_000_000,
  segment_map: segMap,
  role: null,
  episode_id: null,
  output_path: null,
});

const ep = (n: number, name: string | null = `Episode ${n}`): EpisodeRow => ({
  id: 100 + n,
  season_id: 1,
  episode_number: n,
  name,
  runtime_min: 45,
  air_date: null,
  raw_response: null,
});

describe("selectTv", () => {
  test("maps cohort titles to episodes in disc order", () => {
    const titles = [t(0, 2700), t(1, 2680), t(2, 2720), t(3, 30)];
    const episodes = [ep(1), ep(2), ep(3)];
    const sel = selectTv({
      titles,
      episodes,
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(sel.episodeMap).toHaveLength(3);
    expect(sel.episodeMap[0]).toMatchObject({
      title: { makemkv_id: 0 },
      episode: { episode_number: 1 },
    });
    expect(sel.episodeMap[2]).toMatchObject({
      title: { makemkv_id: 2 },
      episode: { episode_number: 3 },
    });
  });

  test("honours --starting-episode for multi-disc seasons", () => {
    const titles = [t(0, 2700), t(1, 2710), t(2, 2690)];
    const episodes = [ep(1), ep(2), ep(3), ep(4), ep(5), ep(6)];
    const sel = selectTv({
      titles,
      episodes,
      minLengthSkipS: 90,
      startingEpisode: 4,
      includeExtras: false,
    });
    expect(sel.episodeMap.map((m) => m.episode.episode_number)).toEqual([4, 5, 6]);
  });

  test("pulls in a single ±40% outlier when cohort is tight", () => {
    // 5 tight ~45-min episodes + a 75-min finale.
    const titles = [
      t(0, 2700),
      t(1, 2720),
      t(2, 2680),
      t(3, 2710),
      t(4, 2700),
      t(5, 4500), // ~67% longer — within ±40% of median (2700)? 4500/2700 = 1.67 → +67%. Outside ±40%.
    ];
    const tight = [
      t(0, 2700),
      t(1, 2710),
      t(2, 2690),
      t(3, 2700),
      t(4, 2700),
      t(5, 3600), // 33% longer — within ±40%
    ];
    const sel = selectTv({
      titles: tight,
      episodes: [ep(1), ep(2), ep(3), ep(4), ep(5), ep(6)],
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(sel.cohort.outlierIncluded?.makemkv_id).toBe(5);
    expect(sel.episodeMap).toHaveLength(6);

    // Sanity: the truly-too-long outlier should NOT be pulled in.
    const selFar = selectTv({
      titles,
      episodes: [ep(1), ep(2), ep(3), ep(4), ep(5)],
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(selFar.cohort.outlierIncluded).toBeNull();
    expect(selFar.episodeMap).toHaveLength(5);
  });

  test("non-cohort survivors go to extras when include-extras is on", () => {
    const titles = [t(0, 2700), t(1, 2720), t(2, 2680), t(3, 600), t(4, 500)];
    const sel = selectTv({
      titles,
      episodes: [ep(1), ep(2), ep(3)],
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: true,
    });
    expect(sel.extras.map((t) => t.makemkv_id).sort()).toEqual([3, 4]);
  });

  test("drops play-all playlists before cohort detection", () => {
    // The play-all (#0) is the concatenation of #1, #2, #3 — it shouldn't
    // hijack the cohort or be mapped to an episode.
    const titles = [
      t(0, 8100, "00800+00801+00802"),
      t(1, 2700, "00800"),
      t(2, 2700, "00801"),
      t(3, 2700, "00802"),
    ];
    const sel = selectTv({
      titles,
      episodes: [ep(1), ep(2), ep(3)],
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(sel.episodeMap.map((m) => m.title.makemkv_id).sort()).toEqual([1, 2, 3]);
    expect(sel.skipped.some((s) => s.title.makemkv_id === 0)).toBe(true);
  });

  test("caps cohort to the remaining season slots and demotes the surplus to extras", () => {
    // Three similar-duration titles but the season has only 2 episodes.
    // The overrun used to throw; now we keep the first 2 as episodes and
    // tag the third as an extra so the user gets the bytes for triage.
    const titles = [t(0, 2700), t(1, 2710), t(2, 2690)];
    const episodes = [ep(1), ep(2)];
    const sel = selectTv({
      titles,
      episodes,
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(sel.episodeMap.map((m) => m.title.makemkv_id)).toEqual([0, 1]);
    expect(sel.extras.map((t) => t.makemkv_id)).toEqual([2]);
    expect(sel.cohortTrimmed?.detected).toBe(3);
    expect(sel.cohortTrimmed?.seatedAsEpisode).toBe(2);
    expect(sel.cohortTrimmed?.demoted.map((t) => t.makemkv_id)).toEqual([2]);
  });

  test("demoted titles tag along as extras even when --include-extras is off", () => {
    // includeExtras=false would normally suppress all extras. But cohort-
    // demoted titles are different: they came from the episode cohort, so
    // the user almost certainly wants them remuxed for re-classification.
    const titles = [t(0, 2700), t(1, 2710), t(2, 2690), t(3, 240)]; // t3 is short → skipped
    const episodes = [ep(1), ep(2)];
    const sel = selectTv({
      titles,
      episodes,
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(sel.extras.map((t) => t.makemkv_id)).toEqual([2]);
    // The non-cohort survivor (t3) was filtered by min-length-skip, so
    // it lands in `skipped`, NOT in extras.
    expect(sel.skipped.some((s) => s.title.makemkv_id === 3)).toBe(true);
  });

  test("starting from mid-season caps against remaining capacity", () => {
    // Multi-disc season scenario: disc 1 claimed E01-E13, disc 2
    // starts at E14 with cohort=13 but only 12 slots remain (E14-E25).
    const titles = Array.from({ length: 13 }, (_, i) => t(i, 1320));
    const episodes = Array.from({ length: 25 }, (_, i) => ep(i + 1));
    const sel = selectTv({
      titles,
      episodes,
      minLengthSkipS: 90,
      startingEpisode: 14,
      includeExtras: false,
    });
    expect(sel.episodeMap).toHaveLength(12);
    expect(sel.episodeMap[0]!.episode.episode_number).toBe(14);
    expect(sel.episodeMap[11]!.episode.episode_number).toBe(25);
    expect(sel.cohortTrimmed?.demoted).toHaveLength(1);
  });

  test("no trim when cohort fits cleanly", () => {
    const titles = [t(0, 2700), t(1, 2710), t(2, 2690)];
    const episodes = [ep(1), ep(2), ep(3)];
    const sel = selectTv({
      titles,
      episodes,
      minLengthSkipS: 90,
      startingEpisode: 1,
      includeExtras: false,
    });
    expect(sel.cohortTrimmed).toBeUndefined();
    expect(sel.episodeMap).toHaveLength(3);
    expect(sel.extras).toHaveLength(0);
  });
});
