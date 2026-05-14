import { describe, expect, test } from "bun:test";
import {
  mergeOverrides,
  tomlBlockToOverrides,
} from "../src/batch.ts";
import type { CliOpts } from "../src/opts.ts";

const baseOpts: CliOpts = {
  type: "auto",
  startingEpisode: 1,
  episodeOrder: "broadcast",
  minLengthSkip: "90s",
  outputFormat: "plex",
};

describe("tomlBlockToOverrides", () => {
  test("maps snake_case TOML keys to camelCase opts", () => {
    expect(
      tomlBlockToOverrides({
        type: "tv",
        show: "Breaking Bad (2008)",
        season: 2,
        starting_episode: 4,
        include_extras: true,
        tmdb_show_id: 1396,
      }),
    ).toEqual({
      type: "tv",
      show: "Breaking Bad (2008)",
      season: 2,
      startingEpisode: 4,
      includeExtras: true,
      tmdbShowId: 1396,
    });
  });

  test("rejects invalid choices silently", () => {
    expect(tomlBlockToOverrides({ type: "anime" })).toEqual({});
    expect(tomlBlockToOverrides({ episode_order: "weird" })).toEqual({});
  });

  test("rejects wrong types silently", () => {
    expect(tomlBlockToOverrides({ season: "2" })).toEqual({}); // expected number
    expect(tomlBlockToOverrides({ include_extras: "yes" })).toEqual({}); // expected bool
  });

  test("min_length_skip accepts string OR literal false", () => {
    expect(tomlBlockToOverrides({ min_length_skip: "5m" })).toEqual({ minLengthSkip: "5m" });
    expect(tomlBlockToOverrides({ min_length_skip: false })).toEqual({ minLengthSkip: "false" });
  });

  test("unknown keys are silently ignored", () => {
    expect(tomlBlockToOverrides({ unknown_future_flag: "x" })).toEqual({});
  });
});

describe("mergeOverrides", () => {
  test("later layers override earlier", () => {
    const merged = mergeOverrides(
      baseOpts,
      { season: 1 },
      { season: 2, startingEpisode: 4 },
    );
    expect(merged.season).toBe(2);
    expect(merged.startingEpisode).toBe(4);
  });

  test("missing keys preserve previous values", () => {
    const merged = mergeOverrides(baseOpts, { season: 2 });
    expect(merged.episodeOrder).toBe("broadcast");
    expect(merged.outputFormat).toBe("plex");
  });

  test("null / undefined layers are ignored", () => {
    const merged = mergeOverrides(baseOpts, null, undefined, { season: 5 });
    expect(merged.season).toBe(5);
  });

  test("explicit undefined inside a layer doesn't clobber", () => {
    const merged = mergeOverrides(
      { ...baseOpts, type: "tv" },
      { type: undefined as unknown as "auto" },
    );
    expect(merged.type).toBe("tv");
  });
});
