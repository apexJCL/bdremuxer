// TMDB API client. Retry / backoff policy lives in ./retry.ts.

import { fetchJsonWithRetry } from "./retry.ts";

const BASE = "https://api.themoviedb.org/3";

export type TmdbConfig = {
  apiKey: string;
  maxTries?: number;
};

export type MovieSearchResult = {
  id: number;
  title: string;
  original_title: string;
  release_date: string | null;
  popularity: number;
  vote_count: number;
  vote_average: number;
};

export type MovieDetails = {
  /** TMDB id. Null when this row was sourced from OMDb only. */
  id: number | null;
  title: string;
  original_title: string;
  release_date: string | null;
  runtime: number | null;
  imdb_id: string | null;
  popularity: number;
  raw: unknown;
};

export type TvSearchResult = {
  id: number;
  name: string;
  original_name: string;
  first_air_date: string | null;
  popularity: number;
  vote_count: number;
  vote_average: number;
};

export type TvShowDetails = {
  id: number;
  name: string;
  original_name: string;
  first_air_date: string | null;
  imdb_id: string | null;
  popularity: number;
  raw: unknown;
};

export type TvEpisodeDetails = {
  id: number;
  episode_number: number;
  name: string | null;
  runtime: number | null;
  air_date: string | null;
  raw: unknown;
};

export type TvSeasonDetails = {
  season_number: number;
  episodes: TvEpisodeDetails[];
  raw: unknown;
};

export class TmdbClient {
  constructor(private cfg: TmdbConfig) {}

  async searchMovie(query: string, year?: number | undefined): Promise<MovieSearchResult[]> {
    const params = new URLSearchParams({ api_key: this.cfg.apiKey, query });
    if (year !== undefined) params.set("year", String(year));
    const data = await this.get<{ results: MovieSearchResult[] }>(`/search/movie?${params}`);
    return data.results ?? [];
  }

  async getMovie(id: number): Promise<MovieDetails> {
    const params = new URLSearchParams({
      api_key: this.cfg.apiKey,
      append_to_response: "external_ids",
    });
    type Raw = {
      id: number;
      title: string;
      original_title: string;
      release_date: string | null;
      runtime: number | null;
      imdb_id: string | null;
      popularity: number;
      external_ids?: { imdb_id?: string | null };
    };
    const data = await this.get<Raw>(`/movie/${id}?${params}`);
    return {
      id: data.id,
      title: data.title,
      original_title: data.original_title,
      release_date: data.release_date,
      runtime: data.runtime,
      imdb_id: data.imdb_id ?? data.external_ids?.imdb_id ?? null,
      popularity: data.popularity,
      raw: data,
    };
  }

  async searchTv(query: string, firstAirYear?: number | undefined): Promise<TvSearchResult[]> {
    const params = new URLSearchParams({ api_key: this.cfg.apiKey, query });
    if (firstAirYear !== undefined) params.set("first_air_date_year", String(firstAirYear));
    const data = await this.get<{ results: TvSearchResult[] }>(`/search/tv?${params}`);
    return data.results ?? [];
  }

  async getTvShow(id: number): Promise<TvShowDetails> {
    const params = new URLSearchParams({
      api_key: this.cfg.apiKey,
      append_to_response: "external_ids",
    });
    type Raw = {
      id: number;
      name: string;
      original_name: string;
      first_air_date: string | null;
      popularity: number;
      external_ids?: { imdb_id?: string | null };
    };
    const data = await this.get<Raw>(`/tv/${id}?${params}`);
    return {
      id: data.id,
      name: data.name,
      original_name: data.original_name,
      first_air_date: data.first_air_date,
      imdb_id: data.external_ids?.imdb_id ?? null,
      popularity: data.popularity,
      raw: data,
    };
  }

  async getTvSeason(showId: number, seasonNumber: number): Promise<TvSeasonDetails> {
    const params = new URLSearchParams({ api_key: this.cfg.apiKey });
    type RawEp = {
      id: number;
      episode_number: number;
      name: string | null;
      runtime: number | null;
      air_date: string | null;
    };
    type Raw = { season_number: number; episodes: RawEp[] };
    const data = await this.get<Raw>(`/tv/${showId}/season/${seasonNumber}?${params}`);
    return {
      season_number: data.season_number,
      episodes: (data.episodes ?? []).map((e) => ({
        id: e.id,
        episode_number: e.episode_number,
        name: e.name,
        runtime: e.runtime,
        air_date: e.air_date,
        raw: e,
      })),
      raw: data,
    };
  }

  async findByImdb(imdbId: string): Promise<MovieDetails | null> {
    const params = new URLSearchParams({
      api_key: this.cfg.apiKey,
      external_source: "imdb_id",
    });
    const data = await this.get<{ movie_results: Array<{ id: number }> }>(
      `/find/${imdbId}?${params}`,
    );
    const first = data.movie_results?.[0];
    if (!first) return null;
    return this.getMovie(first.id);
  }

  private get<T>(pathQ: string): Promise<T> {
    return fetchJsonWithRetry<T>({
      url: `${BASE}${pathQ}`,
      maxTries: this.cfg.maxTries ?? 3,
      service: "TMDB",
    });
  }
}
