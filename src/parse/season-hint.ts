// Extract season/disc/show hints from a disc's volume label, parent dir
// name, or full walker-relative path. Common patterns:
//
//   "BREAKING_BAD_S2_D3"
//   "Breaking Bad - Season 2 - Disc 3"
//   "Breaking.Bad.S02.D1"
//   "Some Show Season 1"
//   "The Wire S03"
//   "SHOW_S1_HDBEE"             ← season embedded with trailing junk
//   "S1 D1"                     ← season-only, no show prefix
//   "SHOW_S1_HDBEE/S1 D1"       ← merge season+disc across segments
//
// Callers fall back to explicit flags (--season N, --show "...") when the
// parser comes up empty.

export type SeasonHint = {
  show?: string;
  season?: number;
  disc?: number;
};

// Looks for "season N" / "sN" / "season N disc M" anywhere in the string,
// with the show name captured as the lazy prefix. Allows trailing junk
// (e.g. "_HDBEE" after the season number).
const SEASON_RE =
  /^(.*?)(?:^|[\s_.-])(?:season|s)[\s_.-]*0*(\d{1,2})(?:[\s_.-]|$)/i;

// Separate disc scan: lets us pull "Disc 3" out even when it doesn't
// follow the season indicator directly.
const DISC_RE =
  /(?:^|[\s_.-])(?:disc|d)[\s_.-]*0*(\d{1,3})(?:[\s_.-]|$)/i;

export function parseSeasonHint(raw: string | null | undefined): SeasonHint {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const out: SeasonHint = {};

  const sm = trimmed.match(SEASON_RE);
  if (sm) {
    out.season = Number(sm[2]);
    // The lazy prefix can absorb a trailing separator (e.g. "Breaking Bad -"
    // from "Breaking Bad - Season 2"). Trim before cleaning.
    const prefix = (sm[1] ?? "").replace(/[\s_.-]+$/, "");
    if (prefix) out.show = cleanShowName(prefix);
  }

  const dm = trimmed.match(DISC_RE);
  if (dm) out.disc = Number(dm[1]);

  return out;
}

// Parse each segment of a relative path and merge. The last (most
// specific) segment wins for any field it produces; earlier segments
// fill in fields the leaf didn't have. Useful for layouts like
// "SHOW_S1_HDBEE/S1 D1" where the parent dir tells us the show
// and the leaf carries the disc number.
export function parseSeasonHintFromPath(relPath: string | null | undefined): SeasonHint {
  if (!relPath) return {};
  const segments = relPath.split(/[\/\\]/).filter(Boolean);
  let merged: SeasonHint = {};
  for (const seg of segments) {
    const h = parseSeasonHint(seg);
    merged = {
      ...merged,
      ...(h.show !== undefined ? { show: h.show } : {}),
      ...(h.season !== undefined ? { season: h.season } : {}),
      ...(h.disc !== undefined ? { disc: h.disc } : {}),
    };
  }
  return merged;
}

// Strip the season hint (and anything after it) from a candidate name so
// the remainder works as a TMDB search query.
//
// Deliberately more permissive than SEASON_RE: we drop the
// trailing-separator requirement so concatenated forms like `S04D01`,
// `s2e7`, or `S01Pack` all strip cleanly to the show prefix. SEASON_RE
// (used for *parsing* the season number, where false positives
// matter) keeps the strict boundary; STRIP_RE is happy to over-strip
// the rare hypothetical title that contains an `sN` substring because
// the much more common case is filenames like
// "Series.Name.Season.1.iso" where the
// search query needs to be just "Series Name".
const STRIP_RE =
  /^(.*?)(?:^|[\s_.-])(?:season|s)[\s_.-]*0*\d{1,2}/i;

export function stripSeasonSuffix(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(STRIP_RE);
  if (!m) return trimmed;
  // Strip trailing separators but preserve embedded ones — callers may
  // want the original form (e.g. "BREAKING_BAD" with underscores intact).
  return (m[1] ?? "").replace(/[\s_.-]+$/, "");
}

function cleanShowName(s: string): string {
  return s.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
}
