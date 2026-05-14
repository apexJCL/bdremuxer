import { describe, expect, test } from "bun:test";
import {
  parseSeasonHint,
  parseSeasonHintFromPath,
  stripSeasonSuffix,
} from "../src/parse/season-hint.ts";

describe("parseSeasonHint", () => {
  test("BREAKING_BAD_S2_D3", () => {
    expect(parseSeasonHint("BREAKING_BAD_S2_D3")).toEqual({
      show: "BREAKING BAD",
      season: 2,
      disc: 3,
    });
  });

  test("Breaking Bad - Season 2 - Disc 3", () => {
    expect(parseSeasonHint("Breaking Bad - Season 2 - Disc 3")).toEqual({
      show: "Breaking Bad",
      season: 2,
      disc: 3,
    });
  });

  test("Breaking.Bad.S02.D1", () => {
    expect(parseSeasonHint("Breaking.Bad.S02.D1")).toEqual({
      show: "Breaking Bad",
      season: 2,
      disc: 1,
    });
  });

  test("Some Show Season 1 (no disc)", () => {
    expect(parseSeasonHint("Some Show Season 1")).toEqual({
      show: "Some Show",
      season: 1,
    });
  });

  test("The Wire S03 (no disc, short form)", () => {
    expect(parseSeasonHint("The Wire S03")).toEqual({
      show: "The Wire",
      season: 3,
    });
  });

  test("no hint returns empty object", () => {
    expect(parseSeasonHint("THE_THING")).toEqual({});
    expect(parseSeasonHint(null)).toEqual({});
    expect(parseSeasonHint("")).toEqual({});
  });

  // Patterns the original parser missed; users hit these in the wild.
  test("S1 D1 (no show prefix, season-first)", () => {
    expect(parseSeasonHint("S1 D1")).toEqual({ season: 1, disc: 1 });
  });

  test("S1 (season only)", () => {
    expect(parseSeasonHint("S1")).toEqual({ season: 1 });
  });

  test("Season 1 (no show prefix, no disc)", () => {
    expect(parseSeasonHint("Season 1")).toEqual({ season: 1 });
  });

  test("SHOW_S1_HDBEE (season with trailing junk)", () => {
    expect(parseSeasonHint("SHOW_S1_HDBEE")).toEqual({
      show: "SHOW",
      season: 1,
    });
  });

  test("Disc 3 alone (disc-only, no season)", () => {
    // Disc is picked up; season stays undefined.
    expect(parseSeasonHint("Disc 3")).toEqual({ disc: 3 });
  });
});

describe("parseSeasonHintFromPath", () => {
  test("merges season from parent dir and disc from child", () => {
    expect(parseSeasonHintFromPath("SHOW_S1_HDBEE/S1 D1")).toEqual({
      show: "SHOW",
      season: 1,
      disc: 1,
    });
  });

  test("merges across three segments", () => {
    expect(parseSeasonHintFromPath("Breaking Bad/Season 2/Disc 3")).toEqual({
      season: 2,
      disc: 3,
    });
  });

  test("child segment overrides parent for the same field", () => {
    // The leaf wins when both have a season — handy if a misnamed parent
    // claims S99 but the actual disc says S1.
    expect(parseSeasonHintFromPath("WRONG_S99_PARENT/S1 D1")).toEqual({
      show: "WRONG",
      season: 1,
      disc: 1,
    });
  });

  test("no parseable season anywhere returns empty", () => {
    expect(parseSeasonHintFromPath("Movies/The Thing")).toEqual({});
  });

  test("empty input", () => {
    expect(parseSeasonHintFromPath("")).toEqual({});
    expect(parseSeasonHintFromPath(null)).toEqual({});
  });
});

describe("stripSeasonSuffix", () => {
  test("removes Season N Disc N suffix", () => {
    expect(stripSeasonSuffix("Breaking Bad - Season 2 - Disc 3")).toBe("Breaking Bad");
  });
  test("removes S2 D3 suffix", () => {
    expect(stripSeasonSuffix("BREAKING_BAD_S2_D3")).toBe("BREAKING_BAD");
  });
  test("leaves the input alone when no suffix", () => {
    expect(stripSeasonSuffix("The Thing 1982")).toBe("The Thing 1982");
  });
  test("strips S04D01-style concatenation (no separator between season and disc)", () => {
    // Scene-style scene release filename — the trailing 'D01' immediately
    // follows 'S04' with no separator, which used to defeat the strip
    // and leak the whole filename into TMDB as a search query.
    expect(
      stripSeasonSuffix("Young.Sheldon.S04D01.COMPLETE.BLURAY-SLIPSTREAM"),
    ).toBe("Young.Sheldon");
  });
  test("strips SnnEnn (episode notation) the same way", () => {
    expect(stripSeasonSuffix("Show.Name.S02E07.Title")).toBe("Show.Name");
  });
});
