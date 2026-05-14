import { describe, expect, test } from "bun:test";
import { buildManifest } from "../src/pipeline/finalize.ts";
import type { DiscRow, MovieRow, TitleRow } from "../src/db.ts";

const disc: DiscRow = {
  id: 1,
  fingerprint: "abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  source_path: "/Volumes/THE_THING",
  volume_label: "THE_THING",
  media_kind: "movie",
  movie_id: 1,
  season_id: null,
  status: "remuxed",
  failed_at_stage: null,
  created_at: "2026-05-13T16:00:00.000Z",
  updated_at: "2026-05-13T16:30:00.000Z",
};

const movie: MovieRow = {
  id: 1,
  tmdb_id: 1091,
  imdb_id: "tt0084787",
  title: "The Thing",
  year: 1982,
  runtime_min: 109,
  raw_response: '{"id":1091}',
};

const titles: TitleRow[] = [
  {
    id: 1,
    disc_id: 1,
    makemkv_id: 0,
    duration_s: 6548,
    size_bytes: 33_420_000_000,
    segment_map: "00800+00801+00802",
    role: "main",
    episode_id: null,
    output_path: "/out/The Thing (1982) [imdbid-tt0084787]/The Thing (1982).mkv",
  },
  {
    id: 2,
    disc_id: 1,
    makemkv_id: 1,
    duration_s: 301,
    size_bytes: 1_200_000_000,
    segment_map: "00811",
    role: "skipped",
    episode_id: null,
    output_path: null,
  },
];

describe("buildManifest", () => {
  const out = buildManifest({
    outDir: "/out",
    disc,
    titles,
    runId: 7,
    shortFp: "abcdef012345",
    bdremuxerVersion: "0.0.1",
    media: { kind: "movie", movie },
  }) as Record<string, unknown> & {
    disc: Record<string, unknown>;
    movie: Record<string, unknown>;
    titles: Array<Record<string, unknown>>;
  };

  test("includes run + version metadata", () => {
    expect(out.version).toBe(1);
    expect(out.bdremuxer_version).toBe("0.0.1");
    expect(out.run_id).toBe(7);
  });

  test("captures disc identity", () => {
    expect(out.disc.fingerprint).toBe(disc.fingerprint);
    expect(out.disc.short_fingerprint).toBe("abcdef012345");
    expect(out.disc.media_kind).toBe("movie");
  });

  test("captures movie identity", () => {
    expect(out.movie).toEqual({
      tmdb_id: 1091,
      imdb_id: "tt0084787",
      title: "The Thing",
      year: 1982,
      runtime_min: 109,
    });
  });

  test("includes every title with role + output_path", () => {
    expect(out.titles).toHaveLength(2);
    expect(out.titles[0]!.role).toBe("main");
    expect(out.titles[0]!.output_path).toContain("The Thing (1982).mkv");
    expect(out.titles[1]!.role).toBe("skipped");
    expect(out.titles[1]!.output_path).toBeNull();
  });
});
