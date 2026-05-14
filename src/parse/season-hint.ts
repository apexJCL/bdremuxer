// Extract season/disc hints from a disc's volume label or parent directory
// name. Common patterns we want to handle:
//
//   "BREAKING_BAD_S2_D3"
//   "Breaking Bad - Season 2 - Disc 3"
//   "Breaking.Bad.S02.D1"
//   "Some Show Season 1"
//   "The Wire S03"
//
// Returns whatever pieces we can pull out. Callers fall back to explicit
// flags (--season N, --show "...") when the parser comes up empty.

export type SeasonHint = {
  show?: string;
  season?: number;
  disc?: number;
};

const SEASON_DISC_RE =
  /^(.+?)[\s_.-]+(?:season|s)[\s_.-]*0*(\d{1,2})(?:[\s_.-]+(?:disc|d)[\s_.-]*0*(\d+))?\s*$/i;

export function parseSeasonHint(raw: string | null | undefined): SeasonHint {
  if (!raw) return {};
  const m = raw.trim().match(SEASON_DISC_RE);
  if (!m) return {};
  return {
    show: cleanShowName(m[1]!),
    season: Number(m[2]),
    disc: m[3] !== undefined ? Number(m[3]) : undefined,
  };
}

// Strip the trailing season/disc suffix from a candidate show name so the
// remainder works as a TMDB search query.
export function stripSeasonSuffix(raw: string): string {
  return raw
    .replace(
      /[\s_.-]+(?:season|s)[\s_.-]*0*\d{1,2}(?:[\s_.-]+(?:disc|d)[\s_.-]*0*\d+)?\s*$/i,
      "",
    )
    .trim();
}

function cleanShowName(s: string): string {
  return s.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
}
