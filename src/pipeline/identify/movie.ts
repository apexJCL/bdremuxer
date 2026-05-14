// §5.4 Identify (movie path).

import type { DB, DiscRow, MovieRow } from "../../db.ts";
import type {
  MovieDetails,
  MovieSearchResult,
  TmdbClient,
} from "../../metadata/tmdb.ts";
import type { OmdbClient, OmdbMovie } from "../../metadata/omdb.ts";

export type MovieIdentifyOpts = {
  client: TmdbClient;
  omdbClient?: OmdbClient | null | undefined;
  tmdbId?: number | undefined;
  imdbId?: string | undefined;
  titleHint?: string | undefined;
  volumeLabel?: string | null | undefined;
  parentDirName?: string | null | undefined;
};

export type MovieIdentifySource =
  | "direct-tmdb"
  | "direct-imdb"
  | "direct-imdb-omdb"
  | "search"
  | "omdb"
  | "omdb-bridge-tmdb";

export type MovieIdentifyResult = {
  details: MovieDetails;
  source: MovieIdentifySource;
  query?: string;
};

export class AmbiguousMatchError extends Error {
  constructor(readonly candidates: MovieSearchResult[]) {
    super(
      `Multiple close matches. Pass --tmdb-id <id> or --imdb-id <tt...> to disambiguate.`,
    );
  }
}

export async function identifyMovie(opts: MovieIdentifyOpts): Promise<MovieIdentifyResult> {
  if (opts.tmdbId !== undefined) {
    return { details: await opts.client.getMovie(opts.tmdbId), source: "direct-tmdb" };
  }
  if (opts.imdbId !== undefined) {
    const details = await opts.client.findByImdb(opts.imdbId);
    if (details) return { details, source: "direct-imdb" };
    // TMDB doesn't know this IMDb id; OMDb sometimes does.
    if (opts.omdbClient) {
      const omdb = await opts.omdbClient.findByImdb(opts.imdbId);
      if (omdb) {
        return { details: omdbToMovieDetails(omdb), source: "direct-imdb-omdb" };
      }
    }
    throw new Error(`No entry found for IMDb id ${opts.imdbId}`);
  }

  const queries = [opts.titleHint, opts.volumeLabel, opts.parentDirName]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map(cleanQuery);

  if (queries.length === 0) {
    throw new Error(
      "No search query available. Pass --title, --tmdb-id, or --imdb-id, or run against a disc whose volume label / parent dir hints at the movie.",
    );
  }

  let lastErr: unknown;

  // 1. TMDB search across each candidate query.
  for (const q of queries) {
    const { name, year } = parseTitleAndYear(q);
    let results: MovieSearchResult[];
    try {
      results = await opts.client.searchMovie(name, year);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (results.length === 0) continue;
    checkAmbiguity(results);
    const top = results[0]!;
    const details = await opts.client.getMovie(top.id);
    return { details, source: "search", query: q };
  }

  // 2. OMDb fallback when TMDB came up empty (§9). Try to bridge back to
  //    TMDB via the IMDb id OMDb returns — TMDB's data is richer.
  if (opts.omdbClient) {
    for (const q of queries) {
      const { name, year } = parseTitleAndYear(q);
      let omdb: OmdbMovie | null;
      try {
        omdb = await opts.omdbClient.searchByTitle(name, year);
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (!omdb) continue;
      try {
        const bridged = await opts.client.findByImdb(omdb.imdb_id);
        if (bridged) return { details: bridged, source: "omdb-bridge-tmdb", query: q };
      } catch {
        // Fall through to using OMDb directly.
      }
      return { details: omdbToMovieDetails(omdb), source: "omdb", query: q };
    }
  }

  if (lastErr) throw lastErr;
  const fallbackHint = opts.omdbClient ? " or OMDb" : "";
  throw new Error(
    `No TMDB${fallbackHint} results for any candidate query: ${queries.join(", ")}`,
  );
}

function omdbToMovieDetails(o: OmdbMovie): MovieDetails {
  return {
    id: null,
    title: o.title,
    original_title: o.title,
    release_date: o.year ? `${o.year}-01-01` : null,
    runtime: o.runtime_min,
    imdb_id: o.imdb_id,
    popularity: 0,
    raw: o.raw,
  };
}

function checkAmbiguity(results: MovieSearchResult[]): void {
  if (results.length < 2) return;
  const top = results[0]!;
  const next = results[1]!;
  if (top.popularity <= 0) return;
  if (next.popularity >= 0.9 * top.popularity) {
    throw new AmbiguousMatchError(results.slice(0, 5));
  }
}

function cleanQuery(s: string): string {
  return s.replace(/^BDMV[/\\]?/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseTitleAndYear(s: string): { name: string; year?: number | undefined } {
  const m = s.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  if (m) return { name: m[1]!.trim(), year: Number(m[2]) };
  return { name: s };
}

export function persistMovie(
  db: DB,
  disc: DiscRow,
  details: MovieDetails,
): { disc: DiscRow; movie: MovieRow } {
  const year = details.release_date ? Number(details.release_date.slice(0, 4)) : null;
  const raw = JSON.stringify(details.raw);

  // Look up an existing row by tmdb_id first (canonical), then by imdb_id
  // (so an OMDb-only identification can later be merged with a richer
  // TMDB result).
  let existing: MovieRow | null = null;
  if (details.id != null) {
    existing = db
      .query<MovieRow, [number]>(`SELECT * FROM movie WHERE tmdb_id = ?`)
      .get(details.id);
  }
  if (!existing && details.imdb_id) {
    existing = db
      .query<MovieRow, [string]>(`SELECT * FROM movie WHERE imdb_id = ?`)
      .get(details.imdb_id);
  }

  let movie: MovieRow;
  if (existing) {
    db.run(
      `UPDATE movie SET tmdb_id = COALESCE(?, tmdb_id), imdb_id = COALESCE(?, imdb_id),
                       title = ?, year = ?, runtime_min = ?, raw_response = ?
       WHERE id = ?`,
      [details.id, details.imdb_id, details.title, year, details.runtime, raw, existing.id],
    );
    movie = {
      ...existing,
      tmdb_id: details.id ?? existing.tmdb_id,
      imdb_id: details.imdb_id ?? existing.imdb_id,
      title: details.title,
      year,
      runtime_min: details.runtime,
      raw_response: raw,
    };
  } else {
    const row = db
      .query<
        MovieRow,
        [number | null, string | null, string, number | null, number | null, string]
      >(
        `INSERT INTO movie (tmdb_id, imdb_id, title, year, runtime_min, raw_response)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(details.id, details.imdb_id, details.title, year, details.runtime, raw);
    if (!row) throw new Error("Failed to insert movie row");
    movie = row;
  }

  const now = new Date().toISOString();
  db.run(
    `UPDATE disc SET movie_id = ?, status = 'identified', updated_at = ? WHERE id = ?`,
    [movie.id, now, disc.id],
  );
  return {
    movie,
    disc: { ...disc, movie_id: movie.id, status: "identified", updated_at: now },
  };
}
