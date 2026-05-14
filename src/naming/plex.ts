// Plex-style movie / TV layouts (§4.1, §4.2).
//
// Movie:
//   <out>/<Title> (<Year>) [imdbid-tt…]/
//     └── <Title> (<Year>).mkv
//
// TV:
//   <out>/<Show> (<Year>) [tmdbid-N]/
//     └── Season 02/
//           ├── <Show> - S02E01 - <Episode>.mkv
//           └── extras/
//
// The [imdbid-…] suffix is preferred; falls back to [tmdbid-N]; falls back
// to no tag if neither external id is known (§4.4). Multi-disc seasons
// produce overlapping `Season NN/` directories across separate runs —
// each disc writes its own episode files into the shared folder.

import { join } from "node:path";

export type MovieIdentity = {
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
};

export type MoviePaths = {
  folder: string;     // <out>/Title (Year) [imdbid-tt…]
  mainMkv: string;    // .../Title (Year).mkv
  extrasDir: string;  // .../extras
};

export function plexMoviePaths(outDir: string, m: MovieIdentity): MoviePaths {
  const safeTitle = sanitizeForPath(m.title);
  const yearPart = m.year ? ` (${m.year})` : "";
  const idTag = formatIdTag(m);
  const folderName = `${safeTitle}${yearPart}${idTag}`;
  const fileName = `${safeTitle}${yearPart}.mkv`;
  const folder = join(outDir, folderName);
  return {
    folder,
    mainMkv: join(folder, fileName),
    extrasDir: join(folder, "extras"),
  };
}

function formatIdTag(ids: { imdb_id: string | null; tmdb_id: number | null }): string {
  if (ids.imdb_id) return ` [imdbid-${ids.imdb_id}]`;
  if (ids.tmdb_id != null) return ` [tmdbid-${ids.tmdb_id}]`;
  return "";
}

// Make a string safe for use as a single path component on macOS / Plex /
// any-of-our-libraries-that-might-cross-FS. Plex itself only forbids `/`
// on the file side, but we standardise on a stricter ruleset so a library
// dropped on an exFAT or SMB share doesn't surprise the user.
//
//   - `:` becomes " - " (preserves the common "Foo: Bar" → "Foo - Bar")
//   - `/`, `\`, `<`, `>`, `"`, `|`, `?`, `*` are stripped
//   - leading/trailing dots are stripped (Windows-hostile)
//   - whitespace is collapsed
export function sanitizeForPath(s: string): string {
  return s
    .replace(/:\s*/g, " - ")
    .replace(/[/\\<>"|?*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

// -----------------------------------------------------------------------
// TV (§4.2)
// -----------------------------------------------------------------------

export type TvIdentity = {
  showName: string;
  firstAirYear: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
};

export type EpisodeIdentity = {
  seasonNumber: number;
  episodeNumber: number;
  episodeName: string | null;
};

export type TvPaths = {
  showFolder: string;    // <out>/Show (Year) [imdbid-…]
  seasonFolder: string;  // .../Season 02
  episodeMkv: string;    // .../Show - S02E01 - Pilot.mkv
  extrasDir: string;     // .../Season 02/extras
};

export function plexTvPaths(
  outDir: string,
  show: TvIdentity,
  ep: EpisodeIdentity,
): TvPaths {
  const safeShow = sanitizeForPath(show.showName);
  const yearPart = show.firstAirYear ? ` (${show.firstAirYear})` : "";
  const idTag = formatIdTag({ imdb_id: show.imdb_id, tmdb_id: show.tmdb_id });

  const showFolder = join(outDir, `${safeShow}${yearPart}${idTag}`);
  const seasonStr = ep.seasonNumber.toString().padStart(2, "0");
  const seasonFolder = join(showFolder, `Season ${seasonStr}`);

  const epNumStr = ep.episodeNumber.toString().padStart(2, "0");
  const epName = ep.episodeName?.trim() || `Episode ${epNumStr}`;
  const safeEpName = sanitizeForPath(epName);
  const fileName = `${safeShow} - S${seasonStr}E${epNumStr} - ${safeEpName}.mkv`;

  return {
    showFolder,
    seasonFolder,
    episodeMkv: join(seasonFolder, fileName),
    extrasDir: join(seasonFolder, "extras"),
  };
}
