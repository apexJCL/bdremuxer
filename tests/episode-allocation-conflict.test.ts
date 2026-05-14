// Multi-disc safety net: when two discs of the same season both default to
// starting_episode = 1 (e.g. a batch.toml glob block that forgets the per-
// disc override), the second disc would silently claim episodes 1-N that
// disc 1 already owns. Remux would then no-op because the MKVs already
// exist on disk, leaving a manifest that lies about disc 2's content.
//
// findEpisodeAllocationConflicts() is the guard the orchestrator runs
// between selectTv() and persistTvSelection() to catch that before any
// rip happens.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { DB } from "../src/db.ts";
import {
  EpisodeAllocationConflictError,
  findEpisodeAllocationConflicts,
  highestClaimedEpisodeInSeason,
} from "../src/pipeline/select/tv.ts";

function openMemoryDb(): DB {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE tv_show (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE season (
      id INTEGER PRIMARY KEY,
      tv_show_id INTEGER NOT NULL REFERENCES tv_show(id),
      season_number INTEGER NOT NULL,
      episode_order TEXT NOT NULL,
      UNIQUE (tv_show_id, season_number, episode_order)
    );
    CREATE TABLE episode (
      id INTEGER PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES season(id),
      episode_number INTEGER NOT NULL,
      UNIQUE (season_id, episode_number)
    );
    CREATE TABLE disc (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT UNIQUE NOT NULL,
      source_path TEXT NOT NULL,
      volume_label TEXT,
      media_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE title (
      id INTEGER PRIMARY KEY,
      disc_id INTEGER NOT NULL REFERENCES disc(id),
      makemkv_id INTEGER NOT NULL,
      duration_s INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      episode_id INTEGER REFERENCES episode(id),
      UNIQUE (disc_id, makemkv_id)
    );
  `);
  return db;
}

type SeededDb = {
  db: DB;
  seasonId: number;
  episodeIds: Record<number, number>;
  disc1Id: number;
  disc2Id: number;
};

function seed(): SeededDb {
  const db = openMemoryDb();
  db.run(`INSERT INTO tv_show (id, name) VALUES (1, 'Show Name')`);
  db.run(
    `INSERT INTO season (id, tv_show_id, season_number, episode_order) VALUES (10, 1, 1, 'broadcast')`,
  );
  const episodeIds: Record<number, number> = {};
  for (let n = 1; n <= 10; n++) {
    const r = db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO episode (season_id, episode_number) VALUES (?, ?) RETURNING id`,
      )
      .get(10, n);
    episodeIds[n] = r!.id;
  }
  const now = new Date().toISOString();
  for (const [id, label] of [
    [100, "SHOW_S1D1"],
    [200, "SHOW_S1D2"],
  ] as const) {
    db.run(
      `INSERT INTO disc (id, fingerprint, source_path, volume_label, media_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'tv', 'classified', ?, ?)`,
      [id, `fp-${label}`, `/Volumes/${label}`, label, now, now],
    );
  }
  return { db, seasonId: 10, episodeIds, disc1Id: 100, disc2Id: 200 };
}

describe("findEpisodeAllocationConflicts", () => {
  test("flags every episode another disc in the season already owns", () => {
    const { db, episodeIds, disc1Id, disc2Id } = seed();
    // Disc 1 already claimed episodes 1-10.
    for (let n = 1; n <= 10; n++) {
      db.run(
        `INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, episode_id) VALUES (?, ?, ?, ?, ?)`,
        [disc1Id, n - 1, 2820, 8_000_000_000, episodeIds[n]!],
      );
    }
    // Disc 2 is about to claim 1-10 too (user forgot per-disc starting_episode).
    const candidates = [1, 2, 3].map((n) => episodeIds[n]!);
    const conflicts = findEpisodeAllocationConflicts(db, disc2Id, candidates);
    expect(conflicts).toHaveLength(3);
    expect(conflicts.map((c) => c.episodeNumber).sort()).toEqual([1, 2, 3]);
    expect(new Set(conflicts.map((c) => c.otherDiscVolumeLabel))).toEqual(
      new Set(["SHOW_S1D1"]),
    );
  });

  test("returns empty when the candidate episodes are unclaimed", () => {
    const { db, episodeIds, disc1Id, disc2Id } = seed();
    for (let n = 1; n <= 5; n++) {
      db.run(
        `INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, episode_id) VALUES (?, ?, ?, ?, ?)`,
        [disc1Id, n - 1, 2820, 8_000_000_000, episodeIds[n]!],
      );
    }
    // Disc 2's proper starting_episode is 6, so candidates are 6-10.
    const candidates = [6, 7, 8, 9, 10].map((n) => episodeIds[n]!);
    expect(findEpisodeAllocationConflicts(db, disc2Id, candidates)).toEqual([]);
  });

  test("re-running the same disc doesn't conflict with itself", () => {
    const { db, episodeIds, disc1Id } = seed();
    for (let n = 1; n <= 10; n++) {
      db.run(
        `INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, episode_id) VALUES (?, ?, ?, ?, ?)`,
        [disc1Id, n - 1, 2820, 8_000_000_000, episodeIds[n]!],
      );
    }
    const candidates = [1, 2, 3].map((n) => episodeIds[n]!);
    expect(findEpisodeAllocationConflicts(db, disc1Id, candidates)).toEqual([]);
  });

  test("empty candidate list short-circuits to no conflicts", () => {
    const { db, disc2Id } = seed();
    expect(findEpisodeAllocationConflicts(db, disc2Id, [])).toEqual([]);
  });
});

describe("highestClaimedEpisodeInSeason", () => {
  test("returns the largest episode_number claimed by other discs", () => {
    const { db, episodeIds, disc1Id, disc2Id } = seed();
    for (let n = 1; n <= 10; n++) {
      db.run(
        `INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, episode_id) VALUES (?, ?, ?, ?, ?)`,
        [disc1Id, n - 1, 2820, 8_000_000_000, episodeIds[n]!],
      );
    }
    expect(highestClaimedEpisodeInSeason(db, 10, disc2Id)).toBe(10);
  });

  test("returns null when no other disc has claimed any episode yet", () => {
    const { db, disc2Id } = seed();
    expect(highestClaimedEpisodeInSeason(db, 10, disc2Id)).toBeNull();
  });
});

describe("EpisodeAllocationConflictError message", () => {
  test("renders a consecutive run as a range with 'are' (Episodes 1-2)", () => {
    const err = new EpisodeAllocationConflictError(
      [
        { episodeId: 1, episodeNumber: 1, otherDiscFingerprint: "fp", otherDiscVolumeLabel: "SHOW_S1D1" },
        { episodeId: 2, episodeNumber: 2, otherDiscFingerprint: "fp", otherDiscVolumeLabel: "SHOW_S1D1" },
      ],
      1,
      "Show Name",
      11,
    );
    expect(err.message).toContain("Episodes 1-2");
    expect(err.message).toContain("are already claimed");
    expect(err.message).toContain("Show Name");
    expect(err.message).toContain("S01");
    expect(err.message).toContain("SHOW_S1D1");
    // The message no longer prescribes a fix — that's the caller's job
    // (planTv builds the suggestion). Belt-and-braces assertion so a
    // future regression that re-inlines the fix is caught.
    expect(err.message).not.toContain("starting_episode");
    expect(err.message).not.toContain("Set ");
  });

  test("collapses a longer consecutive run (1-10) the same way", () => {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const err = new EpisodeAllocationConflictError(
      numbers.map((n) => ({
        episodeId: n,
        episodeNumber: n,
        otherDiscFingerprint: "fp",
        otherDiscVolumeLabel: "S3 D1",
      })),
      3,
      "Show Name",
      11,
    );
    expect(err.message).toContain("Episodes 1-10");
    expect(err.message).not.toContain("E01, E02"); // no more long enumeration
  });

  test("uses singular form for a single conflicting episode", () => {
    const err = new EpisodeAllocationConflictError(
      [{ episodeId: 5, episodeNumber: 5, otherDiscFingerprint: "fp", otherDiscVolumeLabel: "D1" }],
      2,
      "X-Files",
      6,
    );
    expect(err.message).toContain("Episode 5 ");
    expect(err.message).toContain(" is already claimed");
    expect(err.message).not.toContain("Episodes ");
  });

  test("falls back to a comma list when episodes are non-consecutive", () => {
    const err = new EpisodeAllocationConflictError(
      [
        { episodeId: 1, episodeNumber: 1, otherDiscFingerprint: "fp", otherDiscVolumeLabel: "D1" },
        { episodeId: 3, episodeNumber: 3, otherDiscFingerprint: "fp", otherDiscVolumeLabel: "D1" },
        { episodeId: 5, episodeNumber: 5, otherDiscFingerprint: "fp", otherDiscVolumeLabel: "D1" },
      ],
      1,
      "Show",
      6,
    );
    expect(err.message).toContain("Episodes 1, 3, 5");
    expect(err.message).toContain("are already claimed");
  });

  test("uses short fingerprint when no volume label is available", () => {
    const err = new EpisodeAllocationConflictError(
      [{ episodeId: 1, episodeNumber: 1, otherDiscFingerprint: "abcdef0123", otherDiscVolumeLabel: null }],
      2,
      "X-Files",
      null,
    );
    expect(err.message).toContain("Episode 1");
    // No volume label → falls back to short fingerprint.
    expect(err.message).toContain("abcdef01");
    // No prescriptive fix-it text in the message body.
    expect(err.message).not.toContain("starting_episode");
  });
});
