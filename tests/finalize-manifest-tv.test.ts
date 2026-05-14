import { describe, expect, test } from "bun:test";
import { buildManifest } from "../src/pipeline/finalize.ts";
import type {
  DiscRow,
  EpisodeRow,
  SeasonRow,
  TitleRow,
  TvShowRow,
} from "../src/db.ts";

const disc: DiscRow = {
  id: 1,
  fingerprint: "ff01ff02ff03ff04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  source_path: "/Volumes/BREAKING_BAD_S2_D3",
  volume_label: "BREAKING_BAD_S2_D3",
  media_kind: "tv",
  movie_id: null,
  season_id: 2,
  status: "remuxed",
  failed_at_stage: null,
  created_at: "2026-05-13T16:00:00.000Z",
  updated_at: "2026-05-13T17:30:00.000Z",
};

const show: TvShowRow = {
  id: 5,
  tmdb_id: 1396,
  imdb_id: "tt0903747",
  name: "Breaking Bad",
  first_air_year: 2008,
  raw_response: null,
};

const season: SeasonRow = {
  id: 2,
  tv_show_id: 5,
  season_number: 2,
  episode_order: "broadcast",
  raw_response: null,
};

const episodes: EpisodeRow[] = [
  {
    id: 100,
    season_id: 2,
    episode_number: 8,
    name: "Better Call Saul",
    runtime_min: 47,
    air_date: "2009-04-26",
    raw_response: null,
  },
  {
    id: 101,
    season_id: 2,
    episode_number: 9,
    name: "4 Days Out",
    runtime_min: 47,
    air_date: "2009-05-03",
    raw_response: null,
  },
];

const titles: TitleRow[] = [
  {
    id: 1,
    disc_id: 1,
    makemkv_id: 0,
    duration_s: 2820,
    size_bytes: 8_500_000_000,
    segment_map: "00800+00801",
    role: "episode",
    episode_id: 100,
    output_path: "/lib/BB/Season 02/Breaking Bad - S02E08 - Better Call Saul.mkv",
  },
  {
    id: 2,
    disc_id: 1,
    makemkv_id: 1,
    duration_s: 2810,
    size_bytes: 8_400_000_000,
    segment_map: "00802",
    role: "episode",
    episode_id: 101,
    output_path: "/lib/BB/Season 02/Breaking Bad - S02E09 - 4 Days Out.mkv",
  },
];

describe("buildManifest (tv)", () => {
  const out = buildManifest({
    outDir: "/lib",
    outputFormat: "plex",
    disc,
    titles,
    runId: 12,
    shortFp: "ff01ff02ff03",
    bdremuxerVersion: "0.0.1",
    media: { kind: "tv", show, season, episodes },
  }) as Record<string, unknown> & {
    disc: Record<string, unknown>;
    show: Record<string, unknown>;
    season: Record<string, unknown>;
    episodes: Array<Record<string, unknown>>;
    titles: Array<Record<string, unknown>>;
  };

  test("disc carries media_kind=tv", () => {
    expect(out.disc.media_kind).toBe("tv");
  });

  test("show + season + episodes are flattened", () => {
    expect(out.show.tmdb_id).toBe(1396);
    expect(out.show.imdb_id).toBe("tt0903747");
    expect(out.show.first_air_year).toBe(2008);
    expect(out.season.season_number).toBe(2);
    expect(out.season.episode_order).toBe("broadcast");
    expect(out.episodes).toHaveLength(2);
    expect(out.episodes[0]!.episode_number).toBe(8);
    expect(out.episodes[0]!.name).toBe("Better Call Saul");
  });

  test("title rows link to episodes via episode_id", () => {
    expect(out.titles[0]!.role).toBe("episode");
    expect(out.titles[0]!.episode_id).toBe(100);
    expect(out.titles[1]!.episode_id).toBe(101);
  });

  test("tv manifest has no top-level `movie` field", () => {
    expect(out.movie).toBeUndefined();
  });
});
