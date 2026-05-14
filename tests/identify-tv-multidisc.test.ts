// Regression: when a season spans multiple discs, identifying disc 2
// must not invalidate the title→episode links established on disc 1.
//
// The old persistTvIdentification did DELETE FROM episode WHERE season_id = ?
// then re-INSERT. That tripped the FK constraint because disc 1's title rows
// still pointed at the soon-to-be-deleted episode rows. The fix is an UPSERT
// keyed on (season_id, episode_number) so episode IDs stay stable.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { DB, DiscRow, EpisodeRow } from "../src/db.ts";
import {
  persistTvIdentification,
  type TvIdentifyResult,
} from "../src/pipeline/identify/tv.ts";

function openMemoryDb(): DB {
  // Mirrors src/db.ts openDb but without the filesystem dance — we want a
  // throwaway in-memory DB whose FK constraints are active.
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // Re-create the relevant subset of the schema. Keeping this in-line so the
  // test pins the contract it's exercising, rather than coupling to openDb.
  db.exec(`
    CREATE TABLE tv_show (
      id INTEGER PRIMARY KEY,
      tmdb_id INTEGER UNIQUE,
      imdb_id TEXT UNIQUE,
      name TEXT NOT NULL,
      first_air_year INTEGER,
      raw_response TEXT
    );
    CREATE TABLE season (
      id INTEGER PRIMARY KEY,
      tv_show_id INTEGER NOT NULL REFERENCES tv_show(id),
      season_number INTEGER NOT NULL,
      episode_order TEXT NOT NULL CHECK (episode_order IN ('broadcast','production','dvd')),
      raw_response TEXT,
      UNIQUE (tv_show_id, season_number, episode_order)
    );
    CREATE TABLE episode (
      id INTEGER PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES season(id),
      episode_number INTEGER NOT NULL,
      name TEXT,
      runtime_min INTEGER,
      air_date TEXT,
      raw_response TEXT,
      UNIQUE (season_id, episode_number)
    );
    CREATE TABLE disc (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT UNIQUE NOT NULL,
      source_path TEXT NOT NULL,
      volume_label TEXT,
      media_kind TEXT NOT NULL CHECK (media_kind IN ('movie','tv')),
      movie_id INTEGER REFERENCES movie(id),
      season_id INTEGER REFERENCES season(id),
      status TEXT NOT NULL,
      failed_at_stage TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE title (
      id INTEGER PRIMARY KEY,
      disc_id INTEGER NOT NULL REFERENCES disc(id) ON DELETE CASCADE,
      makemkv_id INTEGER NOT NULL,
      duration_s INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      segment_map TEXT,
      role TEXT,
      episode_id INTEGER REFERENCES episode(id),
      output_path TEXT,
      UNIQUE (disc_id, makemkv_id)
    );
    -- movie table is FK-referenced from disc; create a stub so the schema parses.
    CREATE TABLE movie (
      id INTEGER PRIMARY KEY,
      tmdb_id INTEGER UNIQUE,
      imdb_id TEXT UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      runtime_min INTEGER,
      raw_response TEXT
    );
  `);
  return db;
}

function makeDisc(db: DB, fingerprint: string, label: string): DiscRow {
  const now = new Date().toISOString();
  const row = db
    .query<DiscRow, [string, string, string, string, string]>(
      `INSERT INTO disc (fingerprint, source_path, volume_label, media_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'tv', 'classified', ?, ?)
       RETURNING *`,
    )
    .get(fingerprint, `/Volumes/${label}`, label, now, now);
  if (!row) throw new Error("failed to insert disc");
  return row;
}

function makeTitle(db: DB, discId: number, makemkvId: number, durationS: number): number {
  const row = db
    .query<{ id: number }, [number, number, number, number]>(
      `INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    )
    .get(discId, makemkvId, durationS, durationS * 1_000_000);
  if (!row) throw new Error("failed to insert title");
  return row.id;
}

function tvIdentifyResult(): TvIdentifyResult {
  return {
    show: {
      id: 1396,
      name: "Breaking Bad",
      original_name: "Breaking Bad",
      first_air_date: "2008-01-20",
      imdb_id: "tt0903747",
      popularity: 100,
      raw: { tmdb: "show" },
    },
    season: {
      season_number: 2,
      episodes: [
        { id: 1, episode_number: 1, name: "Seven Thirty-Seven", runtime: 47, air_date: "2009-03-08", raw: {} },
        { id: 2, episode_number: 2, name: "Grilled", runtime: 47, air_date: "2009-03-15", raw: {} },
        { id: 3, episode_number: 3, name: "Bit by a Dead Bee", runtime: 47, air_date: "2009-03-22", raw: {} },
        { id: 4, episode_number: 4, name: "Down", runtime: 47, air_date: "2009-03-29", raw: {} },
        { id: 5, episode_number: 5, name: "Breakage", runtime: 47, air_date: "2009-04-05", raw: {} },
        { id: 6, episode_number: 6, name: "Peekaboo", runtime: 47, air_date: "2009-04-12", raw: {} },
      ],
      raw: { tmdb: "season" },
    },
    effectiveEpisodeOrder: "broadcast",
    source: "direct-tmdb",
    seasonSource: "flag",
  };
}

describe("persistTvIdentification across multiple discs of the same season", () => {
  test("does not trip the FK constraint when disc 1's titles still reference episodes", () => {
    const db = openMemoryDb();

    // Disc 1: identify, then simulate the select stage linking title→episode.
    const disc1 = makeDisc(db, "fp-disc-1", "BREAKING_BAD_S2_D1");
    const t1 = makeTitle(db, disc1.id, 0, 2820);
    const t2 = makeTitle(db, disc1.id, 1, 2810);
    const persisted1 = persistTvIdentification(db, disc1, tvIdentifyResult());
    const epId = (n: number): number =>
      persisted1.episodes.find((e) => e.episode_number === n)!.id;
    db.run(`UPDATE title SET role = 'episode', episode_id = ? WHERE id = ?`, [epId(1), t1]);
    db.run(`UPDATE title SET role = 'episode', episode_id = ? WHERE id = ?`, [epId(2), t2]);

    // Disc 2: identify the same season. Before the fix this threw
    // `FOREIGN KEY constraint failed` because the implementation did
    // DELETE FROM episode WHERE season_id = ? while disc 1's titles still
    // pointed at those episode rows.
    const disc2 = makeDisc(db, "fp-disc-2", "BREAKING_BAD_S2_D2");
    const t3 = makeTitle(db, disc2.id, 0, 2820);
    expect(() => persistTvIdentification(db, disc2, tvIdentifyResult())).not.toThrow();

    // Disc 1's title→episode links are intact and still resolve.
    const row1 = db
      .query<{ episode_id: number | null }, [number]>(
        `SELECT episode_id FROM title WHERE id = ?`,
      )
      .get(t1);
    expect(row1?.episode_id).toBe(epId(1));

    // The select stage would now link disc 2; do it manually and make sure
    // the episode IDs from the second identify still match the first set
    // (stable IDs are the contract the FK fix relies on).
    const persisted2Episodes = db
      .query<EpisodeRow, [number]>(`SELECT * FROM episode WHERE season_id = ?`)
      .all(persisted1.season.id);
    expect(persisted2Episodes).toHaveLength(6);

    // Bonus: disc 2 select can target an episode disc 1 didn't.
    db.run(`UPDATE title SET role = 'episode', episode_id = ? WHERE id = ?`, [epId(3), t3]);
    const row3 = db
      .query<{ episode_id: number | null }, [number]>(
        `SELECT episode_id FROM title WHERE id = ?`,
      )
      .get(t3);
    expect(row3?.episode_id).toBe(epId(3));
  });

  test("episode IDs are stable across re-identifies of the same season", () => {
    const db = openMemoryDb();
    const disc = makeDisc(db, "fp-disc", "BB_S2_D1");
    const first = persistTvIdentification(db, disc, tvIdentifyResult());
    const second = persistTvIdentification(db, first.disc, tvIdentifyResult());

    const firstIds = first.episodes.map((e) => e.id).sort((a, b) => a - b);
    const secondIds = second.episodes.map((e) => e.id).sort((a, b) => a - b);
    expect(secondIds).toEqual(firstIds);
  });
});
