// §5.4 Identify (TV path). Resolves the show via TMDB, then the season
// number (flag → parsed from the disc's path), then fetches the season's
// episode list. Persists tv_show, season, and episode rows.

import type {
  DB,
  DiscRow,
  EpisodeOrder,
  EpisodeRow,
  SeasonRow,
  TvShowRow,
} from "../../db.ts";
import type {
  TmdbClient,
  TvSearchResult,
  TvSeasonDetails,
  TvShowDetails,
} from "../../metadata/tmdb.ts";
import { parseSeasonHint, stripSeasonSuffix } from "../../parse/season-hint.ts";

export type TvIdentifyOpts = {
  client: TmdbClient;
  tmdbShowId?: number | undefined;
  showHint?: string | undefined;
  seasonFlag?: number | undefined;
  episodeOrder: EpisodeOrder;
  volumeLabel?: string | null | undefined;
  parentDirName?: string | null | undefined;
};

export type TvIdentifyResult = {
  show: TvShowDetails;
  season: TvSeasonDetails;
  // M4 only honours broadcast order at the API level. If the user asked for
  // production/dvd we warn and fall back; this field reflects what we used.
  effectiveEpisodeOrder: EpisodeOrder;
  source: "direct-tmdb" | "search";
  query?: string;
  seasonSource: "flag" | "parsed";
};

export class AmbiguousTvMatchError extends Error {
  constructor(readonly candidates: TvSearchResult[]) {
    super(
      `Multiple close matches for TV show. Pass --tmdb-show-id <id> to disambiguate.`,
    );
  }
}

export async function identifyTv(opts: TvIdentifyOpts): Promise<TvIdentifyResult> {
  let effectiveEpisodeOrder: EpisodeOrder = opts.episodeOrder;
  if (opts.episodeOrder !== "broadcast") {
    // TMDB episode_groups for production/dvd order lands later — until then
    // we fall back to broadcast and record that we did so.
    process.stderr.write(
      `Warning: --episode-order ${opts.episodeOrder} not yet implemented; using broadcast.\n`,
    );
    effectiveEpisodeOrder = "broadcast";
  }

  const { show, source, query } = await resolveShow(opts);

  const { seasonNumber, seasonSource } = resolveSeasonNumber(opts);

  let season: TvSeasonDetails;
  try {
    season = await opts.client.getTvSeason(show.id, seasonNumber);
  } catch (e) {
    throw new Error(
      `TMDB has no season ${seasonNumber} for "${show.name}" (TMDB:${show.id}). ${(e as Error).message}`,
    );
  }

  return { show, season, effectiveEpisodeOrder, source, query, seasonSource };
}

async function resolveShow(
  opts: TvIdentifyOpts,
): Promise<{ show: TvShowDetails; source: "direct-tmdb" | "search"; query?: string }> {
  if (opts.tmdbShowId !== undefined) {
    return { show: await opts.client.getTvShow(opts.tmdbShowId), source: "direct-tmdb" };
  }

  const queries = [opts.showHint, opts.volumeLabel, opts.parentDirName]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => stripSeasonSuffix(cleanQuery(s)))
    .filter((s) => s.length > 0);

  if (queries.length === 0) {
    throw new Error(
      "No TV show query available. Pass --show, --tmdb-show-id, or run against a disc whose volume label / parent dir hints at the show.",
    );
  }

  let lastErr: unknown;
  for (const q of queries) {
    let results: TvSearchResult[];
    try {
      results = await opts.client.searchTv(q);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (results.length === 0) continue;
    checkAmbiguity(results);
    const show = await opts.client.getTvShow(results[0]!.id);
    return { show, source: "search", query: q };
  }
  if (lastErr) throw lastErr;
  throw new Error(`No TMDB results for any candidate query: ${queries.join(", ")}`);
}

function resolveSeasonNumber(opts: TvIdentifyOpts): {
  seasonNumber: number;
  seasonSource: "flag" | "parsed";
} {
  if (opts.seasonFlag !== undefined) {
    return { seasonNumber: opts.seasonFlag, seasonSource: "flag" };
  }
  const fromLabel = parseSeasonHint(opts.volumeLabel ?? null).season;
  const fromParent = parseSeasonHint(opts.parentDirName ?? null).season;
  const parsed = fromLabel ?? fromParent;
  if (parsed !== undefined) return { seasonNumber: parsed, seasonSource: "parsed" };
  throw new Error(
    "Season number is required for TV. Pass --season N or include the season in the disc's volume label / parent directory name (e.g. 'S2', 'Season 2').",
  );
}

function checkAmbiguity(results: TvSearchResult[]): void {
  if (results.length < 2) return;
  const top = results[0]!;
  const next = results[1]!;
  if (top.popularity <= 0) return;
  if (next.popularity >= 0.9 * top.popularity) {
    throw new AmbiguousTvMatchError(results.slice(0, 5));
  }
}

function cleanQuery(s: string): string {
  return s.replace(/^BDMV[/\\]?/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

// -----------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------

export type PersistedTvIdentification = {
  disc: DiscRow;
  show: TvShowRow;
  season: SeasonRow;
  episodes: EpisodeRow[];
};

export function persistTvIdentification(
  db: DB,
  disc: DiscRow,
  identified: TvIdentifyResult,
): PersistedTvIdentification {
  return db.transaction((): PersistedTvIdentification => {
    const show = upsertTvShow(db, identified.show);
    const season = upsertSeason(
      db,
      show.id,
      identified.season.season_number,
      identified.effectiveEpisodeOrder,
      identified.season.raw,
    );
    // Upsert each episode by (season_id, episode_number) so the row IDs stay
    // stable across re-runs and across sibling discs that share a season.
    // A DELETE+INSERT approach would invalidate title.episode_id refs held
    // by titles on other discs of the same season and trip the FK constraint.
    const upsertEp = db.query<
      EpisodeRow,
      [number, number, string | null, number | null, string | null, string]
    >(
      `INSERT INTO episode (season_id, episode_number, name, runtime_min, air_date, raw_response)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (season_id, episode_number) DO UPDATE SET
         name         = excluded.name,
         runtime_min  = excluded.runtime_min,
         air_date     = excluded.air_date,
         raw_response = excluded.raw_response
       RETURNING *`,
    );
    const episodes: EpisodeRow[] = [];
    for (const ep of identified.season.episodes) {
      const row = upsertEp.get(
        season.id,
        ep.episode_number,
        ep.name,
        ep.runtime,
        ep.air_date,
        JSON.stringify(ep.raw),
      );
      if (!row) throw new Error(`Failed to upsert episode ${ep.episode_number}`);
      episodes.push(row);
    }

    const now = new Date().toISOString();
    db.run(
      `UPDATE disc SET season_id = ?, status = 'identified', updated_at = ? WHERE id = ?`,
      [season.id, now, disc.id],
    );
    return {
      disc: { ...disc, season_id: season.id, status: "identified", updated_at: now },
      show,
      season,
      episodes,
    };
  })();
}

function upsertTvShow(db: DB, details: TvShowDetails): TvShowRow {
  const firstAirYear = details.first_air_date
    ? Number(details.first_air_date.slice(0, 4))
    : null;
  const raw = JSON.stringify(details.raw);

  const existing = db
    .query<TvShowRow, [number]>(`SELECT * FROM tv_show WHERE tmdb_id = ?`)
    .get(details.id);
  if (existing) {
    db.run(
      `UPDATE tv_show SET imdb_id = ?, name = ?, first_air_year = ?, raw_response = ?
       WHERE id = ?`,
      [details.imdb_id, details.name, firstAirYear, raw, existing.id],
    );
    return {
      ...existing,
      imdb_id: details.imdb_id,
      name: details.name,
      first_air_year: firstAirYear,
      raw_response: raw,
    };
  }

  const row = db
    .query<TvShowRow, [number, string | null, string, number | null, string]>(
      `INSERT INTO tv_show (tmdb_id, imdb_id, name, first_air_year, raw_response)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(details.id, details.imdb_id, details.name, firstAirYear, raw);
  if (!row) throw new Error("Failed to insert tv_show row");
  return row;
}

function upsertSeason(
  db: DB,
  tvShowId: number,
  seasonNumber: number,
  order: EpisodeOrder,
  rawSeason: unknown,
): SeasonRow {
  const raw = JSON.stringify(rawSeason);
  const existing = db
    .query<SeasonRow, [number, number, string]>(
      `SELECT * FROM season WHERE tv_show_id = ? AND season_number = ? AND episode_order = ?`,
    )
    .get(tvShowId, seasonNumber, order);
  if (existing) {
    db.run(`UPDATE season SET raw_response = ? WHERE id = ?`, [raw, existing.id]);
    return { ...existing, raw_response: raw };
  }
  const row = db
    .query<SeasonRow, [number, number, string, string]>(
      `INSERT INTO season (tv_show_id, season_number, episode_order, raw_response)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(tvShowId, seasonNumber, order, raw);
  if (!row) throw new Error("Failed to insert season row");
  return row;
}
