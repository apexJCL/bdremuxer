// Plan summary/issue-report rendering + stale-done detection.
// The orchestrator pipes pure data through these; pinning their shape here
// keeps them honest and lets us iterate on copy without breaking the
// invariants downstream consumers care about.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DiscPlan,
  DiscPlanReady,
  MoviePlanData,
  TvPlanData,
} from "../src/pipeline/plan.ts";
import {
  checkStaleDone,
  countPlans,
  formatIssueReport,
  formatPlanLine,
  formatPlanOutcomeShort,
  formatPlanSummary,
} from "../src/pipeline/plan.ts";
import type {
  DiscRow,
  EpisodeRow,
  MovieRow,
  SeasonRow,
  TitleRow,
  TvShowRow,
} from "../src/db.ts";

// -----------------------------------------------------------------------
// fixtures
// -----------------------------------------------------------------------

const baseDisc: DiscRow = {
  id: 1,
  fingerprint: "abc123def456" + "0".repeat(52),
  source_path: "/Volumes/X",
  volume_label: "X",
  media_kind: "movie",
  movie_id: null,
  season_id: null,
  status: "selected",
  failed_at_stage: null,
  created_at: "2026-05-14T00:00:00Z",
  updated_at: "2026-05-14T00:00:00Z",
};

const movie: MovieRow = {
  id: 10,
  tmdb_id: 1091,
  imdb_id: "tt0084787",
  title: "The Thing",
  year: 1982,
  runtime_min: 109,
  raw_response: null,
};

const movieMain: TitleRow = {
  id: 1, disc_id: 1, makemkv_id: 0, duration_s: 6540, size_bytes: 30_000_000_000,
  segment_map: "00800", role: "main", episode_id: null, output_path: null,
};

const moviePlan: MoviePlanData = {
  kind: "movie",
  movie,
  selection: { main: movieMain, extras: [], skipped: [] },
  identifySource: "search",
};

const movieReady: DiscPlanReady = {
  kind: "ready",
  relPath: "THE_THING",
  absPath: "/Volumes/library/THE_THING",
  shortFp: "abc123def456",
  fingerprint: baseDisc.fingerprint,
  volumeLabel: "THE_THING",
  disc: { ...baseDisc, media_kind: "movie", movie_id: 10 },
  titleRows: [movieMain],
  media: moviePlan,
};

// TV fixture: Show Name S01 D1 (E01-E03).
const show: TvShowRow = {
  id: 5, tmdb_id: 12345, imdb_id: null, name: "Show Name", first_air_year: 2020, raw_response: null,
};
const season: SeasonRow = {
  id: 50, tv_show_id: 5, season_number: 1, episode_order: "broadcast", raw_response: null,
};
const episodes: EpisodeRow[] = [
  { id: 100, season_id: 50, episode_number: 1, name: "Pilot", runtime_min: 22, air_date: null, raw_response: null },
  { id: 101, season_id: 50, episode_number: 2, name: "Episode Two", runtime_min: 22, air_date: null, raw_response: null },
  { id: 102, season_id: 50, episode_number: 3, name: "Episode Three", runtime_min: 22, air_date: null, raw_response: null },
];
const tvTitles: TitleRow[] = episodes.map((e, i) => ({
  id: 10 + i, disc_id: 2, makemkv_id: i, duration_s: 1320, size_bytes: 5_000_000_000,
  segment_map: null, role: "episode", episode_id: e.id, output_path: null,
}));
const tvPlan: TvPlanData = {
  kind: "tv",
  show,
  season,
  episodes,
  selection: {
    episodeMap: tvTitles.map((t, i) => ({ title: t, episode: episodes[i]! })),
    extras: [],
    skipped: [],
    cohort: { median: 1320, count: 3, relStdev: 0, outlierIncluded: null },
  },
  identifySource: "direct-tmdb",
  seasonSource: "flag",
  effectiveEpisodeOrder: "broadcast",
};
const tvReady: DiscPlanReady = {
  kind: "ready",
  relPath: "SHOW_S1D1",
  absPath: "/Volumes/library/SHOW_S1D1",
  shortFp: "deadbeef0000",
  fingerprint: "deadbeef" + "0".repeat(56),
  volumeLabel: "SHOW_S1D1",
  disc: { ...baseDisc, id: 2, media_kind: "tv", season_id: 50 },
  titleRows: tvTitles,
  media: tvPlan,
};

// -----------------------------------------------------------------------
// counting + line formatting
// -----------------------------------------------------------------------

describe("countPlans", () => {
  test("buckets each DiscPlan variant separately", () => {
    const plans: DiscPlan[] = [
      movieReady,
      tvReady,
      { kind: "blocked", relPath: "X", absPath: "/X", stage: "identify", reason: "ambiguous" },
      { kind: "already-done", relPath: "Y", absPath: "/Y", disc: baseDisc, outputPath: "/out/y.mkv" },
      { kind: "stale-done", relPath: "Z", absPath: "/Z", disc: baseDisc, missingOutputs: ["/out/z.mkv"] },
    ];
    expect(countPlans(plans)).toEqual({
      ready: 2,
      blocked: 1,
      alreadyDone: 1,
      staleDone: 1,
      total: 5,
    });
  });
});

describe("formatPlanLine", () => {
  test("ready movie line names the movie + year + extras count", () => {
    const out = formatPlanLine({
      ...movieReady,
      media: {
        ...moviePlan,
        selection: { ...moviePlan.selection, extras: [movieMain] },
      },
    });
    expect(out).toContain("THE_THING");
    expect(out).toContain("The Thing (1982)");
    expect(out).toContain("+ 1 extra");
  });

  test("ready tv line names show, season, and episode range", () => {
    const out = formatPlanLine(tvReady);
    expect(out).toContain("SHOW_S1D1");
    expect(out).toContain("Show Name S01");
    expect(out).toContain("3 episodes");
    expect(out).toContain("E01-E03");
  });

  test("blocked line surfaces stage + reason + suggestion", () => {
    const out = formatPlanLine({
      kind: "blocked",
      relPath: "M",
      absPath: "/M",
      stage: "select",
      reason: "Episode allocation conflict",
      suggestion: "Set starting_episode = 11",
    });
    expect(out).toContain("M");
    expect(out).toContain("select:");
    expect(out).toContain("Episode allocation conflict");
    expect(out).toContain("Set starting_episode = 11");
  });

  test("already-done line includes output path", () => {
    const out = formatPlanLine({
      kind: "already-done",
      relPath: "Y",
      absPath: "/Y",
      disc: baseDisc,
      outputPath: "/lib/Y.mkv",
    });
    expect(out).toContain("already done");
    expect(out).toContain("/lib/Y.mkv");
  });

  test("stale-done line points the user at --force", () => {
    const out = formatPlanLine({
      kind: "stale-done",
      relPath: "Z",
      absPath: "/Z",
      disc: baseDisc,
      missingOutputs: ["/out/missing.mkv"],
    });
    expect(out).toContain("stale");
    expect(out).toContain("1 output(s) missing");
    expect(out).toContain("--force");
  });
});

describe("formatPlanOutcomeShort", () => {
  test("ready movie collapses to one line with title + year", () => {
    const out = formatPlanOutcomeShort(movieReady);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("ready");
    expect(out).toContain("The Thing (1982)");
  });

  test("ready tv shows show + season + episode count", () => {
    const out = formatPlanOutcomeShort(tvReady);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("ready");
    expect(out).toContain("Show Name");
    expect(out).toContain("S01");
    expect(out).toContain("3 ep");
  });

  test("blocked surfaces the FULL reason (no 80-char truncation) plus suggestion on a second line", () => {
    // Regression: the previous implementation sliced the reason to 80
    // chars, cutting messages like "Episodes 1-11 of … are already
    // claimed by another disc (S1 D1). Starting episode will be set to
    // 12 …" mid-sentence and hiding the actionable tail. The full text
    // must survive intact, with the suggestion landing on its own
    // indented continuation line.
    const longReason =
      `Episodes 1-11 of "Show Name" S01 are already claimed by another disc (S1 D1). ` +
      `This is the same season detected across multiple discs.`;
    const out = formatPlanOutcomeShort({
      kind: "blocked",
      relPath: "S1 D2",
      absPath: "/x",
      stage: "select",
      reason: longReason,
      suggestion:
        "Starting episode will be set to 12 for this disc — verify this is correct.",
    });
    expect(out).toContain("blocked at select");
    expect(out).toContain("are already claimed by another disc");
    expect(out).toContain("Episodes 1-11");
    // Suggestion lands on a follow-up line indented for grouping.
    expect(out).toContain("\n      → Starting episode will be set to 12");
    expect(out).toContain("verify this is correct");
  });

  test("blocked without a suggestion stays single-line", () => {
    const out = formatPlanOutcomeShort({
      kind: "blocked",
      relPath: "M",
      absPath: "/M",
      stage: "identify",
      reason: "TMDB returned 0 results",
    });
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("blocked at identify");
    expect(out).toContain("TMDB returned 0 results");
  });

  test("already-done is the simplest case", () => {
    const out = formatPlanOutcomeShort({
      kind: "already-done",
      relPath: "Y",
      absPath: "/Y",
      disc: baseDisc,
      outputPath: null,
    });
    expect(out).toBe("⊙ already done");
  });

  test("stale-done reports the missing-output count and lists paths", () => {
    const out = formatPlanOutcomeShort({
      kind: "stale-done",
      relPath: "Z",
      absPath: "/Z",
      disc: baseDisc,
      missingOutputs: ["/a.mkv", "/b.mkv"],
    });
    expect(out).toContain("stale");
    expect(out).toContain("2 output(s)");
    expect(out).toContain("/a.mkv");
    expect(out).toContain("/b.mkv");
    expect(out).toContain("--force");
  });

  test("stale-done truncates long missing-outputs lists to 3 + count", () => {
    const out = formatPlanOutcomeShort({
      kind: "stale-done",
      relPath: "Z",
      absPath: "/Z",
      disc: baseDisc,
      missingOutputs: ["/a.mkv", "/b.mkv", "/c.mkv", "/d.mkv", "/e.mkv"],
    });
    expect(out).toContain("/a.mkv");
    expect(out).toContain("/c.mkv");
    expect(out).not.toContain("/d.mkv");
    expect(out).toContain("… and 2 more");
  });
});

describe("formatPlanSummary", () => {
  test("ends with a counts line", () => {
    const out = formatPlanSummary([movieReady, tvReady], "/Volumes/library");
    expect(out).toContain("2/2 ready");
    expect(out).toContain("0 blocked");
    expect(out).toContain("/Volumes/library");
  });
});

describe("formatIssueReport", () => {
  test("returns empty string when nothing needs attention", () => {
    expect(formatIssueReport([movieReady])).toBe("");
  });

  test("aggregates blocked + stale-done into one worklist", () => {
    const out = formatIssueReport([
      { kind: "blocked", relPath: "A", absPath: "/A", stage: "identify", reason: "ambiguous", suggestion: "pin tmdb_id" },
      { kind: "stale-done", relPath: "B", absPath: "/B", disc: baseDisc, missingOutputs: ["/x.mkv", "/y.mkv"] },
    ]);
    expect(out).toContain("2 disc(s) need attention");
    expect(out).toContain("A");
    expect(out).toContain("identify: ambiguous");
    expect(out).toContain("pin tmdb_id");
    expect(out).toContain("B");
    expect(out).toContain("2 output(s) missing");
    expect(out).toContain("--force");
  });

  test("truncates the missing-outputs list to three", () => {
    const out = formatIssueReport([
      {
        kind: "stale-done",
        relPath: "B",
        absPath: "/B",
        disc: baseDisc,
        missingOutputs: ["/a.mkv", "/b.mkv", "/c.mkv", "/d.mkv", "/e.mkv"],
      },
    ]);
    expect(out).toContain("and 2 more");
  });
});

// -----------------------------------------------------------------------
// checkStaleDone — hits a tmpdir for the file existence check
// -----------------------------------------------------------------------

function tmpFile(name: string, contents = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "bdremuxer-stale-"));
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function discDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE title (
      id INTEGER PRIMARY KEY,
      disc_id INTEGER NOT NULL,
      makemkv_id INTEGER NOT NULL,
      duration_s INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      segment_map TEXT,
      role TEXT,
      episode_id INTEGER,
      output_path TEXT
    );
  `);
  return db;
}

describe("checkStaleDone", () => {
  test("ok when every role∈(main,episode) output_path still exists", () => {
    const db = discDb();
    const a = tmpFile("a.mkv");
    const b = tmpFile("b.mkv");
    db.run(`INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, role, output_path) VALUES (?,?,?,?,?,?)`,
      [1, 0, 100, 1000, "main", a]);
    db.run(`INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, role, output_path) VALUES (?,?,?,?,?,?)`,
      [1, 1, 100, 1000, "episode", b]);
    expect(checkStaleDone(db, 1)).toEqual({ ok: true });
  });

  test("returns missing list when at least one output is gone", () => {
    const db = discDb();
    const present = tmpFile("present.mkv");
    db.run(`INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, role, output_path) VALUES (?,?,?,?,?,?)`,
      [1, 0, 100, 1000, "main", present]);
    db.run(`INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, role, output_path) VALUES (?,?,?,?,?,?)`,
      [1, 1, 100, 1000, "episode", "/nonexistent/gone.mkv"]);
    const res = checkStaleDone(db, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toEqual(["/nonexistent/gone.mkv"]);
    }
  });

  test("ignores extras + skipped roles + null output_path", () => {
    const db = discDb();
    db.run(`INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, role, output_path) VALUES (?,?,?,?,?,?)`,
      [1, 0, 100, 1000, "extra", "/nonexistent/extra.mkv"]);
    db.run(`INSERT INTO title (disc_id, makemkv_id, duration_s, size_bytes, role, output_path) VALUES (?,?,?,?,?,?)`,
      [1, 1, 100, 1000, "skipped", null]);
    expect(checkStaleDone(db, 1)).toEqual({ ok: true });
  });
});
