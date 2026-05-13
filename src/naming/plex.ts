// Plex-style movie layout (§4.1).
//
//   <out>/<Title> (<Year>) [imdbid-tt…]/
//     └── <Title> (<Year>).mkv
//
// The [imdbid-…] suffix is preferred; falls back to [tmdbid-N]; falls back
// to no tag if neither external id is known (§4.4).

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

function formatIdTag(m: MovieIdentity): string {
  if (m.imdb_id) return ` [imdbid-${m.imdb_id}]`;
  if (m.tmdb_id != null) return ` [tmdbid-${m.tmdb_id}]`;
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
