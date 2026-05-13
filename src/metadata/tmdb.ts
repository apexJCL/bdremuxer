// TMDB API client with the retry policy from spec §10:
//   - retry on network errors, HTTP 5xx, HTTP 429 (honour Retry-After)
//   - fail fast on other 4xx (auth, 404, bad request)
//   - 3 tries with 1s/2s/4s backoff

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
  id: number;
  title: string;
  original_title: string;
  release_date: string | null;
  runtime: number | null;
  imdb_id: string | null;
  popularity: number;
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

  private async get<T>(pathQ: string): Promise<T> {
    const maxTries = this.cfg.maxTries ?? 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        let res: Response;
        try {
          res = await fetch(`${BASE}${pathQ}`);
        } catch (e) {
          throw new RetryableError(
            `TMDB network error: ${(e as Error).message}`,
            backoffMs(attempt),
          );
        }
        if (res.ok) return (await res.json()) as T;
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs(attempt);
          throw new RetryableError(`TMDB 429 rate-limited`, delay);
        }
        if (res.status >= 500) {
          throw new RetryableError(`TMDB ${res.status}`, backoffMs(attempt));
        }
        const body = await res.text().catch(() => "");
        throw new Error(`TMDB ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      } catch (e) {
        lastErr = e;
        if (e instanceof RetryableError && attempt < maxTries) {
          await sleep(e.delayMs);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}

class RetryableError extends Error {
  constructor(message: string, readonly delayMs: number) {
    super(message);
  }
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
