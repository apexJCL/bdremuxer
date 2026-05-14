import { describe, expect, test } from "bun:test";
import { parseSeasonHint, stripSeasonSuffix } from "../src/parse/season-hint.ts";

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
});
