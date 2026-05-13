import { describe, expect, test } from "bun:test";
import { plexMoviePaths, sanitizeForPath } from "../src/naming/plex.ts";

describe("sanitizeForPath", () => {
  test("preserves a clean title", () => {
    expect(sanitizeForPath("The Thing")).toBe("The Thing");
  });
  test("replaces colon-space with dash-space (Plex convention)", () => {
    expect(sanitizeForPath("Blade Runner: The Final Cut")).toBe(
      "Blade Runner - The Final Cut",
    );
  });
  test("strips filesystem-hostile characters", () => {
    expect(sanitizeForPath('What/Is\\This*?"<>|')).toBe("WhatIsThis");
  });
  test("collapses whitespace", () => {
    expect(sanitizeForPath("Mad   Max:    Fury Road")).toBe("Mad Max - Fury Road");
  });
  test("strips leading/trailing dots", () => {
    expect(sanitizeForPath("..Hidden..")).toBe("Hidden");
  });
});

describe("plexMoviePaths", () => {
  test("uses imdb id when present", () => {
    const p = plexMoviePaths("/out", {
      title: "The Thing",
      year: 1982,
      imdb_id: "tt0084787",
      tmdb_id: 1091,
    });
    expect(p.folder).toBe("/out/The Thing (1982) [imdbid-tt0084787]");
    expect(p.mainMkv).toBe(
      "/out/The Thing (1982) [imdbid-tt0084787]/The Thing (1982).mkv",
    );
    expect(p.extrasDir).toBe(
      "/out/The Thing (1982) [imdbid-tt0084787]/extras",
    );
  });

  test("falls back to tmdb id when imdb missing", () => {
    const p = plexMoviePaths("/out", {
      title: "Some Indie Film",
      year: 2024,
      imdb_id: null,
      tmdb_id: 999999,
    });
    expect(p.folder).toBe("/out/Some Indie Film (2024) [tmdbid-999999]");
  });

  test("no tag when neither id is known", () => {
    const p = plexMoviePaths("/out", {
      title: "Lost Reel",
      year: null,
      imdb_id: null,
      tmdb_id: null,
    });
    expect(p.folder).toBe("/out/Lost Reel");
    expect(p.mainMkv).toBe("/out/Lost Reel/Lost Reel.mkv");
  });

  test("sanitizes title before composing paths", () => {
    const p = plexMoviePaths("/out", {
      title: "Spider-Man: Across the Spider-Verse",
      year: 2023,
      imdb_id: "tt9362722",
      tmdb_id: 569094,
    });
    expect(p.folder).toBe(
      "/out/Spider-Man - Across the Spider-Verse (2023) [imdbid-tt9362722]",
    );
  });
});
