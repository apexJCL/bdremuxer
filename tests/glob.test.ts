import { describe, expect, test } from "bun:test";
import { globMatch } from "../src/parse/glob.ts";

describe("globMatch", () => {
  test("literal match", () => {
    expect(globMatch("Breaking Bad - S2 - Disc 1", "Breaking Bad - S2 - Disc 1")).toBe(true);
    expect(globMatch("Breaking Bad - S2 - Disc 1", "Breaking Bad - S2 - Disc 2")).toBe(false);
  });

  test("* matches non-slash run", () => {
    expect(globMatch("Breaking Bad - S2*", "Breaking Bad - S2 - Disc 1")).toBe(true);
    expect(globMatch("Breaking Bad - S2*", "Breaking Bad - S2")).toBe(true);
    expect(globMatch("Breaking Bad - S2*", "Breaking Bad - S3")).toBe(false);
  });

  test("* does NOT cross directory boundaries", () => {
    expect(globMatch("TV/*", "TV/Breaking Bad")).toBe(true);
    expect(globMatch("TV/*", "TV/Breaking Bad/Disc 1")).toBe(false);
  });

  test("** crosses directory boundaries", () => {
    expect(globMatch("TV/**", "TV/Breaking Bad/Disc 1")).toBe(true);
    expect(globMatch("TV/**", "TV/Breaking Bad")).toBe(true);
  });

  test("regex metacharacters are escaped", () => {
    expect(globMatch("Movie (1982)", "Movie (1982)")).toBe(true);
    expect(globMatch("Movie.With.Dots", "MovieXWithXDots")).toBe(false);
  });
});
