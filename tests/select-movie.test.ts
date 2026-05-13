import { describe, expect, test } from "bun:test";
import { selectMovie } from "../src/pipeline/select/movie.ts";
import type { TitleRow } from "../src/db.ts";

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

describe("selectMovie", () => {
  test("picks the longest title when no TMDB runtime", () => {
    const titles = [t(0, 3000), t(1, 6500), t(2, 30)];
    const sel = selectMovie({
      titles,
      minLengthSkipS: 90,
      tmdbRuntimeMin: null,
      includeExtras: false,
    });
    expect(sel.main.makemkv_id).toBe(1);
    expect(sel.skipped.find((s) => s.title.makemkv_id === 2)?.reason).toContain(
      "below min-length-skip",
    );
  });

  test("prefers title within ±10% of TMDB runtime", () => {
    // Two contenders, the longer one is way over the TMDB runtime → pick the
    // shorter one that matches.
    const titles = [t(0, 9000), t(1, 6540)]; // tmdb runtime = 109 min → ~6540s
    const sel = selectMovie({
      titles,
      minLengthSkipS: 90,
      tmdbRuntimeMin: 109,
      includeExtras: false,
    });
    expect(sel.main.makemkv_id).toBe(1);
  });

  test("filters play-all playlists by segment-map concat", () => {
    const titles = [
      t(0, 2400, "00800+00801+00802"), // play-all
      t(1, 1200, "00800"),
      t(2, 600, "00801"),
      t(3, 600, "00802"),
    ];
    const sel = selectMovie({
      titles,
      minLengthSkipS: 90,
      tmdbRuntimeMin: null,
      includeExtras: false,
    });
    // Play-all (title 0) should be skipped; longest of the rest is title 1.
    expect(sel.main.makemkv_id).toBe(1);
    expect(sel.skipped.some((s) => s.title.makemkv_id === 0)).toBe(true);
  });

  test("include-extras keeps non-main survivors", () => {
    const titles = [t(0, 6500), t(1, 600), t(2, 400)];
    const sel = selectMovie({
      titles,
      minLengthSkipS: 90,
      tmdbRuntimeMin: null,
      includeExtras: true,
    });
    expect(sel.main.makemkv_id).toBe(0);
    expect(sel.extras.map((t) => t.makemkv_id).sort()).toEqual([1, 2]);
  });
});
