// §5.3 Classify: decide whether the disc is a movie or a TV box-set.
//
// M2 wires the heuristic up end-to-end but only the 'movie' branch goes
// further down the pipeline; 'tv' is recognised but bounced with a
// "lands in M4" message. The caller updates `disc.media_kind` if the
// classification differs from the scan-time tentative value.

import type { DB, DiscRow, TitleRow } from "../db.ts";

export type MediaKind = "movie" | "tv";

export type ClassifyInput = {
  titles: TitleRow[];
  volumeLabel: string | null;
  parentDirName: string | null;
  minLengthSkipS: number | null;
  typeFlag?: MediaKind | undefined;
};

const TV_HINT_RE = /season|s\d{1,2}|disc\s*\d/i;

export function classify(input: ClassifyInput): MediaKind {
  if (input.typeFlag) return input.typeFlag;

  const filtered =
    input.minLengthSkipS == null
      ? input.titles
      : input.titles.filter((t) => t.duration_s >= input.minLengthSkipS!);

  if (filtered.length === 0) {
    throw new ClassifyError(
      "No titles survive --min-length-skip; cannot classify. Pass --type explicitly or relax --min-length-skip.",
    );
  }

  const sorted = [...filtered].sort((a, b) => b.duration_s - a.duration_s);
  const longest = sorted[0]!;
  const second = sorted[1];

  // Movie indicator: one dominant title (≥ 1.5× the runner-up, or only one title at all)
  if (!second || longest.duration_s >= 1.5 * second.duration_s) {
    return "movie";
  }

  // TV indicator: ≥ 3 titles within ±15 % of each other AND a season hint in
  // the volume label / parent dir.
  if (sorted.length >= 3) {
    const median = sorted[1]!.duration_s;
    const top3 = sorted.slice(0, 3);
    const tight = top3.every((t) => Math.abs(t.duration_s - median) / median <= 0.15);
    const hint = `${input.volumeLabel ?? ""} ${input.parentDirName ?? ""}`;
    if (tight && TV_HINT_RE.test(hint)) return "tv";
  }

  throw new ClassifyError(
    "Could not classify automatically — top titles are similar but no season hint in the volume label/parent dir. Pass --type movie or --type tv.",
  );
}

export class ClassifyError extends Error {}

export function persistMediaKind(db: DB, disc: DiscRow, kind: MediaKind): DiscRow {
  const now = new Date().toISOString();
  if (disc.media_kind !== kind) {
    db.run(`UPDATE disc SET media_kind = ?, updated_at = ? WHERE id = ?`, [
      kind,
      now,
      disc.id,
    ]);
  }
  db.run(`UPDATE disc SET status = 'classified', updated_at = ? WHERE id = ?`, [
    now,
    disc.id,
  ]);
  return { ...disc, media_kind: kind, status: "classified", updated_at: now };
}
