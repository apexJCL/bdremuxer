// §5.7 Finalize: write the per-disc manifest, mark `disc.status='done'`.
// For flat layout, also write a per-title JSON sidecar next to each MKV.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  DB,
  DiscRow,
  EpisodeRow,
  MovieRow,
  SeasonRow,
  TitleRow,
  TvShowRow,
} from "../db.ts";
import type { OutputFormat } from "../opts.ts";
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
  outputFormat: OutputFormat;
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

  // Flat layout: drop a per-title sidecar next to each MKV (§4.3).
  if (input.outputFormat === "flat") {
    for (const t of input.titles) {
      if (!t.output_path || t.role === "skipped" || t.role === null) continue;
      const sidecar = buildTitleSidecar(input, t);
      const sidecarPath = t.output_path.replace(/\.mkv$/, ".json");
      mkdirSync(dirname(sidecarPath), { recursive: true });
      writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    }
  }

  const now = new Date().toISOString();
  input.db.run(`UPDATE disc SET status = 'done', updated_at = ? WHERE id = ?`, [
    now,
    input.disc.id,
  ]);
  finishRun(input.db, input.runId, true);

  return { manifestPath };
}

export function buildTitleSidecar(
  input: Omit<FinalizeInput, "db">,
  title: TitleRow,
): unknown {
  const base: Record<string, unknown> = {
    version: 1,
    bdremuxer_version: input.bdremuxerVersion,
    disc: {
      fingerprint: input.disc.fingerprint,
      short_fingerprint: input.shortFp,
      media_kind: input.disc.media_kind,
    },
    title: {
      makemkv_id: title.makemkv_id,
      duration_s: title.duration_s,
      size_bytes: title.size_bytes,
      role: title.role,
      output_path: title.output_path,
    },
  };
  if (input.media.kind === "movie") {
    const m = input.media.movie;
    base.movie = { tmdb_id: m.tmdb_id, imdb_id: m.imdb_id, title: m.title, year: m.year };
  } else {
    const { show, season, episodes } = input.media;
    base.show = { tmdb_id: show.tmdb_id, imdb_id: show.imdb_id, name: show.name };
    base.season = { season_number: season.season_number };
    if (title.episode_id) {
      const ep = episodes.find((e) => e.id === title.episode_id);
      if (ep) {
        base.episode = {
          episode_number: ep.episode_number,
          name: ep.name,
        };
      }
    }
  }
  return base;
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
