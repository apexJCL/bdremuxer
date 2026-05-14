// Typed view of the merged CLI / TOML option set. Used by both the
// commander setup in cli.ts and the batch override resolver in batch.ts.

import type { EpisodeOrder } from "./db.ts";

export type OutputFormat = "plex" | "flat" | "jellyfin" | "kodi";

export type CliOpts = {
  type: "movie" | "tv" | "auto";
  title?: string;
  tmdbId?: number;
  imdbId?: string;
  show?: string;
  tmdbShowId?: number;
  season?: number;
  startingEpisode: number;
  episodeOrder: EpisodeOrder;
  includeExtras?: boolean;
  minLengthSkip: string;
  out?: string;
  db?: string;
  makemkvcon?: string;
  outputFormat: OutputFormat;
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
};
