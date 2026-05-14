import { describe, expect, test } from "bun:test";
import { plexTvPaths } from "../src/naming/plex.ts";

describe("plexTvPaths", () => {
  test("basic show + season + episode", () => {
    const p = plexTvPaths(
      "/library",
      { showName: "Breaking Bad", firstAirYear: 2008, imdb_id: "tt0903747", tmdb_id: 1396 },
      { seasonNumber: 2, episodeNumber: 1, episodeName: "Seven Thirty-Seven" },
    );
    expect(p.showFolder).toBe("/library/Breaking Bad (2008) [imdbid-tt0903747]");
    expect(p.seasonFolder).toBe(
      "/library/Breaking Bad (2008) [imdbid-tt0903747]/Season 02",
    );
    expect(p.episodeMkv).toBe(
      "/library/Breaking Bad (2008) [imdbid-tt0903747]/Season 02/Breaking Bad - S02E01 - Seven Thirty-Seven.mkv",
    );
    expect(p.extrasDir).toBe(
      "/library/Breaking Bad (2008) [imdbid-tt0903747]/Season 02/extras",
    );
  });

  test("falls back to tmdbid tag when imdb missing", () => {
    const p = plexTvPaths(
      "/lib",
      { showName: "Some Anime", firstAirYear: 2024, imdb_id: null, tmdb_id: 99999 },
      { seasonNumber: 1, episodeNumber: 1, episodeName: "Pilot" },
    );
    expect(p.showFolder).toBe("/lib/Some Anime (2024) [tmdbid-99999]");
  });

  test("episode-number padding handles ≥ 100 (long-running shows)", () => {
    const p = plexTvPaths(
      "/lib",
      { showName: "The Simpsons", firstAirYear: 1989, imdb_id: null, tmdb_id: 456 },
      { seasonNumber: 6, episodeNumber: 100, episodeName: "Treehouse" },
    );
    expect(p.episodeMkv).toContain("S06E100 - Treehouse.mkv");
  });

  test("missing episode name falls back to 'Episode NN'", () => {
    const p = plexTvPaths(
      "/lib",
      { showName: "Cryptic Show", firstAirYear: null, imdb_id: null, tmdb_id: 1 },
      { seasonNumber: 1, episodeNumber: 3, episodeName: null },
    );
    expect(p.episodeMkv).toContain("S01E03 - Episode 03.mkv");
  });

  test("sanitizes episode names with colons", () => {
    const p = plexTvPaths(
      "/lib",
      { showName: "Dr. Who", firstAirYear: null, imdb_id: null, tmdb_id: 1 },
      { seasonNumber: 1, episodeNumber: 1, episodeName: "Rose: A New Beginning" },
    );
    expect(p.episodeMkv).toContain("S01E01 - Rose - A New Beginning.mkv");
  });

  test("strips filesystem-hostile characters from show + episode name", () => {
    const p = plexTvPaths(
      "/lib",
      {
        showName: 'What/Is\\This?',
        firstAirYear: 2020,
        imdb_id: null,
        tmdb_id: 1,
      },
      { seasonNumber: 1, episodeNumber: 1, episodeName: 'A"B*C' },
    );
    expect(p.episodeMkv).toBe(
      "/lib/WhatIsThis (2020) [tmdbid-1]/Season 01/WhatIsThis - S01E01 - ABC.mkv",
    );
  });

  test("two discs of the same season share the same season folder", () => {
    const a = plexTvPaths(
      "/lib",
      { showName: "Breaking Bad", firstAirYear: 2008, imdb_id: "tt0903747", tmdb_id: 1396 },
      { seasonNumber: 2, episodeNumber: 1, episodeName: "A" },
    );
    const b = plexTvPaths(
      "/lib",
      { showName: "Breaking Bad", firstAirYear: 2008, imdb_id: "tt0903747", tmdb_id: 1396 },
      { seasonNumber: 2, episodeNumber: 5, episodeName: "B" },
    );
    expect(a.seasonFolder).toBe(b.seasonFolder);
    expect(a.episodeMkv).not.toBe(b.episodeMkv);
  });
});
