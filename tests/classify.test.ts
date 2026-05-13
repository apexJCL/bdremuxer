import { describe, expect, test } from "bun:test";
import { classify, ClassifyError } from "../src/pipeline/classify.ts";
import type { TitleRow } from "../src/db.ts";

const t = (id: number, durationS: number): TitleRow => ({
  id,
  disc_id: 1,
  makemkv_id: id,
  duration_s: durationS,
  size_bytes: durationS * 1_000_000,
  segment_map: null,
  role: null,
  episode_id: null,
  output_path: null,
});

describe("classify", () => {
  test("respects --type flag", () => {
    expect(
      classify({
        titles: [t(0, 5400)],
        volumeLabel: null,
        parentDirName: null,
        minLengthSkipS: 90,
        typeFlag: "tv",
      }),
    ).toBe("tv");
  });

  test("dominant title → movie", () => {
    const titles = [t(0, 6500), t(1, 300), t(2, 200), t(3, 150)];
    expect(
      classify({ titles, volumeLabel: null, parentDirName: null, minLengthSkipS: 90 }),
    ).toBe("movie");
  });

  test("tight cohort + season hint → tv", () => {
    const titles = [t(0, 2600), t(1, 2580), t(2, 2620), t(3, 300)];
    expect(
      classify({
        titles,
        volumeLabel: "BREAKING_BAD_S2_D3",
        parentDirName: null,
        minLengthSkipS: 90,
      }),
    ).toBe("tv");
  });

  test("tight cohort without hint → ambiguous error", () => {
    const titles = [t(0, 2600), t(1, 2580), t(2, 2620), t(3, 300)];
    expect(() =>
      classify({
        titles,
        volumeLabel: "RANDOM_VOLUME",
        parentDirName: null,
        minLengthSkipS: 90,
      }),
    ).toThrow(ClassifyError);
  });

  test("min-length-skip excludes shorts before classifying", () => {
    // Without the filter the shorts would tilt classification.
    const titles = [t(0, 6500), t(1, 30), t(2, 30), t(3, 30)];
    expect(
      classify({ titles, volumeLabel: null, parentDirName: null, minLengthSkipS: 90 }),
    ).toBe("movie");
  });

  test("empty after filter → throws", () => {
    expect(() =>
      classify({
        titles: [t(0, 10)],
        volumeLabel: null,
        parentDirName: null,
        minLengthSkipS: 90,
      }),
    ).toThrow(ClassifyError);
  });
});
