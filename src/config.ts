// Runtime configuration.
//
// M2 reads everything from env vars and CLI flags only — TOML config-file
// support lands later when there's more than just an API key to keep.

import { join, resolve } from "node:path";

export type Config = {
  tmdbApiKey: string | null;
  omdbApiKey: string | null;
  outDir: string;
  dbPath: string;
};

export type ConfigOverrides = {
  outDir?: string;
  dbPath?: string;
};

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const outDir = resolve(overrides.outDir ?? process.env["BDREMUXER_OUTPUT_DIR"] ?? "./out");
  const dbPath = resolve(
    overrides.dbPath ??
      process.env["BDREMUXER_DB_PATH"] ??
      join(outDir, ".bdremuxer.sqlite"),
  );
  const tmdbApiKey = process.env["BDREMUXER_TMDB_API_KEY"] ?? null;
  const omdbApiKey = process.env["BDREMUXER_OMDB_API_KEY"] ?? null;
  return { tmdbApiKey, omdbApiKey, outDir, dbPath };
}
