// Flat output layout (§4.3).
//
//   <out>/<source-disc-name>__title_<NN>.mkv
//   <out>/<source-disc-name>__title_<NN>.json   ← per-title sidecar
//
// Useful for triage / inspection. No subdirectories, no [imdbid-…] tag —
// you can drop the SQLite DB or the per-disc manifest next to the MKVs
// to recover full context.

import { join } from "node:path";
import { sanitizeForPath } from "./plex.ts";

export function flatTitlePath(
  outDir: string,
  discName: string,
  makemkvId: number,
): string {
  const safe = sanitizeForPath(discName);
  const idStr = makemkvId.toString().padStart(2, "0");
  return join(outDir, `${safe}__title_${idStr}.mkv`);
}

export function flatTitleSidecarPath(
  outDir: string,
  discName: string,
  makemkvId: number,
): string {
  return flatTitlePath(outDir, discName, makemkvId).replace(/\.mkv$/, ".json");
}
