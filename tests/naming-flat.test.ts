import { describe, expect, test } from "bun:test";
import { flatTitlePath, flatTitleSidecarPath } from "../src/naming/flat.ts";

describe("flatTitlePath", () => {
  test("basic naming", () => {
    expect(flatTitlePath("/out", "THE_THING", 0)).toBe("/out/THE_THING__title_00.mkv");
    expect(flatTitlePath("/out", "BREAKING_BAD_S2_D1", 3)).toBe(
      "/out/BREAKING_BAD_S2_D1__title_03.mkv",
    );
  });

  test("sanitizes disc names with hostile chars", () => {
    expect(flatTitlePath("/out", "Movie: Awesome", 1)).toBe(
      "/out/Movie - Awesome__title_01.mkv",
    );
  });

  test("zero-pads makemkv ids past 9", () => {
    expect(flatTitlePath("/out", "DISC", 10)).toBe("/out/DISC__title_10.mkv");
    expect(flatTitlePath("/out", "DISC", 100)).toBe("/out/DISC__title_100.mkv");
  });
});

describe("flatTitleSidecarPath", () => {
  test("swaps .mkv extension for .json", () => {
    expect(flatTitleSidecarPath("/out", "DISC", 1)).toBe("/out/DISC__title_01.json");
  });
});
