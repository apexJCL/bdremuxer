// OMDb API client. Used as a fallback when TMDB returns no results (§9).
// Free tier permits 1000 requests/day.

import { fetchJsonWithRetry } from "./retry.ts";

const BASE = "https://www.omdbapi.com";

export type OmdbConfig = {
  apiKey: string;
  maxTries?: number;
};

export type OmdbMovie = {
  imdb_id: string;
  title: string;
  year: number | null;
  runtime_min: number | null;
  raw: unknown;
};

type OmdbRawHit = {
  Response: "True" | "False";
  Error?: string;
  imdbID?: string;
  Title?: string;
  Year?: string;
  Runtime?: string;
  Type?: string;
};

export class OmdbClient {
  constructor(private cfg: OmdbConfig) {}

  async searchByTitle(
    query: string,
    year?: number | undefined,
  ): Promise<OmdbMovie | null> {
    const params = new URLSearchParams({
      apikey: this.cfg.apiKey,
      t: query,
      type: "movie",
    });
    if (year !== undefined) params.set("y", String(year));
    return this.normalize(await this.get(`?${params}`));
  }

  async findByImdb(imdbId: string): Promise<OmdbMovie | null> {
    const params = new URLSearchParams({ apikey: this.cfg.apiKey, i: imdbId });
    return this.normalize(await this.get(`?${params}`));
  }

  private normalize(data: OmdbRawHit): OmdbMovie | null {
    if (data.Response !== "True" || !data.imdbID || !data.Title) return null;
    return {
      imdb_id: data.imdbID,
      title: data.Title,
      year: data.Year ? parseYear(data.Year) : null,
      runtime_min: parseRuntimeMin(data.Runtime),
      raw: data,
    };
  }

  private get(pathQ: string): Promise<OmdbRawHit> {
    return fetchJsonWithRetry<OmdbRawHit>({
      url: `${BASE}/${pathQ}`,
      maxTries: this.cfg.maxTries ?? 3,
      service: "OMDb",
    });
  }
}

// "1982" → 1982; "1982–1985" (a series range) → 1982; junk → null
function parseYear(s: string): number | null {
  const m = s.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

// "109 min" → 109; "N/A" or missing → null
function parseRuntimeMin(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)\s*min/i);
  return m ? Number(m[1]) : null;
}
