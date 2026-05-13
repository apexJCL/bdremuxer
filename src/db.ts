// SQLite layer (bun:sqlite).
//
// Schema is created on demand; no migration framework yet — when one is
// needed (M4-ish, when adding TV tables hits in earnest) we'll add a
// `schema_version` table and step migrations. For M2 we lay down all
// tables from spec §8 up-front; the ones the pipeline doesn't touch yet
// (tv_show, season, episode) sit empty until M4.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database;

export type DiscRow = {
  id: number;
  fingerprint: string;
  source_path: string;
  volume_label: string | null;
  media_kind: "movie" | "tv";
  movie_id: number | null;
  season_id: number | null;
  status: DiscStatus;
  failed_at_stage: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscStatus =
  | "scanned"
  | "probed"
  | "classified"
  | "identified"
  | "selected"
  | "remuxed"
  | "done"
  | "failed";

export type MovieRow = {
  id: number;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string;
  year: number | null;
  runtime_min: number | null;
  raw_response: string | null;
};

export type TitleRow = {
  id: number;
  disc_id: number;
  makemkv_id: number;
  duration_s: number;
  size_bytes: number;
  segment_map: string | null;
  role: "main" | "episode" | "extra" | "skipped" | null;
  episode_id: number | null;
  output_path: string | null;
};

export type TrackRow = {
  id: number;
  title_id: number;
  kind: string;
  codec: string | null;
  language: string | null;
  channels: number | null;
  flags: string | null;
};

// title.role is left nullable until §5.5 (select); spec §8 has it NOT NULL
// but the probe stage in §5.2 persists titles before selection runs. The
// enum constraint still applies once a role is assigned.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS movie (
  id           INTEGER PRIMARY KEY,
  tmdb_id      INTEGER UNIQUE,
  imdb_id      TEXT UNIQUE,
  title        TEXT NOT NULL,
  year         INTEGER,
  runtime_min  INTEGER,
  raw_response TEXT
);

CREATE TABLE IF NOT EXISTS tv_show (
  id             INTEGER PRIMARY KEY,
  tmdb_id        INTEGER UNIQUE,
  imdb_id        TEXT UNIQUE,
  name           TEXT NOT NULL,
  first_air_year INTEGER,
  raw_response   TEXT
);

CREATE TABLE IF NOT EXISTS season (
  id            INTEGER PRIMARY KEY,
  tv_show_id    INTEGER NOT NULL REFERENCES tv_show(id),
  season_number INTEGER NOT NULL,
  episode_order TEXT NOT NULL CHECK (episode_order IN ('broadcast','production','dvd')),
  raw_response  TEXT,
  UNIQUE (tv_show_id, season_number, episode_order)
);

CREATE TABLE IF NOT EXISTS episode (
  id             INTEGER PRIMARY KEY,
  season_id      INTEGER NOT NULL REFERENCES season(id),
  episode_number INTEGER NOT NULL,
  name           TEXT,
  runtime_min    INTEGER,
  air_date       TEXT,
  raw_response   TEXT,
  UNIQUE (season_id, episode_number)
);

CREATE TABLE IF NOT EXISTS disc (
  id              INTEGER PRIMARY KEY,
  fingerprint     TEXT UNIQUE NOT NULL,
  source_path     TEXT NOT NULL,
  volume_label    TEXT,
  media_kind      TEXT NOT NULL CHECK (media_kind IN ('movie','tv')),
  movie_id        INTEGER REFERENCES movie(id),
  season_id       INTEGER REFERENCES season(id),
  status          TEXT NOT NULL CHECK (status IN (
                    'scanned','probed','classified','identified',
                    'selected','remuxed','done','failed')),
  failed_at_stage TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (
    (media_kind = 'movie' AND season_id IS NULL) OR
    (media_kind = 'tv'    AND movie_id  IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS title (
  id          INTEGER PRIMARY KEY,
  disc_id     INTEGER NOT NULL REFERENCES disc(id) ON DELETE CASCADE,
  makemkv_id  INTEGER NOT NULL,
  duration_s  INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL,
  segment_map TEXT,
  role        TEXT CHECK (role IS NULL OR role IN ('main','episode','extra','skipped')),
  episode_id  INTEGER REFERENCES episode(id),
  output_path TEXT,
  UNIQUE (disc_id, makemkv_id)
);

CREATE TABLE IF NOT EXISTS track (
  id        INTEGER PRIMARY KEY,
  title_id  INTEGER NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  codec     TEXT,
  language  TEXT,
  channels  INTEGER,
  flags     TEXT
);

CREATE TABLE IF NOT EXISTS run (
  id          INTEGER PRIMARY KEY,
  disc_id     INTEGER NOT NULL REFERENCES disc(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  log_path    TEXT
);
`;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
