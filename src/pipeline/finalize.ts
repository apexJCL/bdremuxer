// §5.7 Finalize: write the per-disc manifest, mark `disc.status='done'`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DB, DiscRow, MovieRow, TitleRow } from "../db.ts";
import { finishRun } from "./run.ts";

export type ManifestInput = {
  db: DB;
  outDir: string;
  disc: DiscRow;
  movie: MovieRow;
  titles: TitleRow[];      // every title from the disc (with role/output_path filled in)
  runId: number;
  shortFp: string;
  bdremuxerVersion: string;
};

export type FinalizeResult = {
  manifestPath: string;
};

export function finalize(input: ManifestInput): FinalizeResult {
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

export function buildManifest(input: Omit<ManifestInput, "db">): unknown {
  return {
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
    movie: {
      tmdb_id: input.movie.tmdb_id,
      imdb_id: input.movie.imdb_id,
      title: input.movie.title,
      year: input.movie.year,
      runtime_min: input.movie.runtime_min,
    },
    titles: input.titles.map((t) => ({
      makemkv_id: t.makemkv_id,
      duration_s: t.duration_s,
      size_bytes: t.size_bytes,
      segment_map: t.segment_map,
      role: t.role,
      output_path: t.output_path,
    })),
  };
}
