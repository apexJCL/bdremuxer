// §5.7 Finalize: write the per-disc manifest, mark `disc.status='done'`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DB,
  DiscRow,
  EpisodeRow,
  MovieRow,
  SeasonRow,
  TitleRow,
  TvShowRow,
} from "../db.ts";
import { finishRun } from "./run.ts";

export type MovieManifestInput = {
  kind: "movie";
  movie: MovieRow;
};

export type TvManifestInput = {
  kind: "tv";
  show: TvShowRow;
  season: SeasonRow;
  episodes: EpisodeRow[];
};

export type FinalizeInput = {
  db: DB;
  outDir: string;
  disc: DiscRow;
  titles: TitleRow[];      // every title row for the disc (with role/output_path filled in)
  runId: number;
  shortFp: string;
  bdremuxerVersion: string;
  media: MovieManifestInput | TvManifestInput;
};

export type FinalizeResult = {
  manifestPath: string;
};

export function finalize(input: FinalizeInput): FinalizeResult {
  const manifest = buildManifest(input);

  const manifestDir = join(input.outDir, ".bdremuxer", "manifests");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, `${input.shortFp}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const now = new Date().toISOString();
  input.db.run(`UPDATE disc SET status = 'done', updated_at = ? WHERE id = ?`, [
    now,
    input.disc.id,
  ]);
  finishRun(input.db, input.runId, true);

  return { manifestPath };
}

export function buildManifest(input: Omit<FinalizeInput, "db">): unknown {
  const base: Record<string, unknown> = {
    version: 1,
    bdremuxer_version: input.bdremuxerVersion,
    run_id: input.runId,
    disc: {
      fingerprint: input.disc.fingerprint,
      short_fingerprint: input.shortFp,
      source_path: input.disc.source_path,
      volume_label: input.disc.volume_label,
      media_kind: input.disc.media_kind,
    },
    titles: input.titles.map((t) => ({
      makemkv_id: t.makemkv_id,
      duration_s: t.duration_s,
      size_bytes: t.size_bytes,
      segment_map: t.segment_map,
      role: t.role,
      episode_id: t.episode_id,
      output_path: t.output_path,
    })),
  };

  if (input.media.kind === "movie") {
    const m = input.media.movie;
    base.movie = {
      tmdb_id: m.tmdb_id,
      imdb_id: m.imdb_id,
      title: m.title,
      year: m.year,
      runtime_min: m.runtime_min,
    };
    return base;
  }

  const { show, season, episodes } = input.media;
  base.show = {
    tmdb_id: show.tmdb_id,
    imdb_id: show.imdb_id,
    name: show.name,
    first_air_year: show.first_air_year,
  };
  base.season = {
    season_number: season.season_number,
    episode_order: season.episode_order,
  };
  base.episodes = episodes.map((e) => ({
    id: e.id,
    episode_number: e.episode_number,
    name: e.name,
    runtime_min: e.runtime_min,
    air_date: e.air_date,
  }));
  return base;
}
