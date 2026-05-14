// §5.6 Remux: invoke `makemkvcon mkv` for each selected title, then move
// the produced file into its final Plex-named location.
//
// M3 only ships the movie path with a single (main) title. Extras and TV
// land in later milestones; this stage's shape is intentionally amenable
// to looping over multiple titles when those land.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  DB,
  DiscRow,
  EpisodeRow,
  MovieRow,
  SeasonRow,
  TitleRow,
  TvShowRow,
} from "../db.ts";
import { runMkv } from "../makemkv/cli.ts";
import {
  plexMoviePaths,
  plexTvPaths,
  type MovieIdentity,
  type TvIdentity,
} from "../naming/plex.ts";
import { setRunLogPath } from "./run.ts";

export type RemuxOpts = {
  db: DB;
  outDir: string;
  makemkvcon: string;
  discRoot: string;
  disc: DiscRow;
  movie: MovieRow;
  mainTitle: TitleRow;
  runId: number;
  force: boolean;
  shortFp: string;
  onProgress?: (frac: number, task?: string) => void;
};

export type RemuxResult = {
  outputPath: string;
  skipped: boolean;       // true when the final MKV already existed and !force
  logPath: string;
};

export async function remuxMovieMain(opts: RemuxOpts): Promise<RemuxResult> {
  const identity: MovieIdentity = {
    title: opts.movie.title,
    year: opts.movie.year,
    imdb_id: opts.movie.imdb_id,
    tmdb_id: opts.movie.tmdb_id,
  };
  const paths = plexMoviePaths(opts.outDir, identity);

  const logDir = join(opts.outDir, ".bdremuxer", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${opts.shortFp}-${opts.runId}.log`);
  setRunLogPath(opts.db, opts.runId, logPath);

  // Idempotency: if the final file is already there and we're not forcing,
  // just leave it alone. Caller can decide whether to still re-finalize.
  if (!opts.force && existsSync(paths.mainMkv)) {
    opts.db.run(
      `UPDATE title SET role = 'main', output_path = ? WHERE id = ?`,
      [paths.mainMkv, opts.mainTitle.id],
    );
    return { outputPath: paths.mainMkv, skipped: true, logPath };
  }

  mkdirSync(paths.folder, { recursive: true });

  // Use a per-disc tmp dir so concurrent invocations against different
  // discs don't trip over each other. Cleared first so a previous failed
  // run doesn't pollute the produced filename.
  const tmpDir = join(
    opts.outDir,
    ".bdremuxer",
    "tmp",
    opts.shortFp,
    `title-${opts.mainTitle.makemkv_id}`,
  );
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  await runMkv({
    makemkvcon: opts.makemkvcon,
    source: `file:${opts.discRoot}`,
    titleId: opts.mainTitle.makemkv_id,
    outputDir: tmpDir,
    logPath,
    onProgress: opts.onProgress,
  });

  // Find the produced MKV. For a single-title rip MakeMKV produces exactly
  // one .mkv file; if multiple show up, take the largest.
  const produced = readdirSync(tmpDir)
    .filter((n) => n.toLowerCase().endsWith(".mkv"))
    .map((n) => join(tmpDir, n))
    .sort((a, b) => statSync(b).size - statSync(a).size);

  if (produced.length === 0) {
    throw new Error(`makemkvcon produced no MKV files in ${tmpDir}. See log: ${logPath}`);
  }
  const src = produced[0]!;

  // Overwrite any prior file (a --force re-run, or a prior partial).
  rmSync(paths.mainMkv, { force: true });
  renameSync(src, paths.mainMkv);
  rmSync(tmpDir, { recursive: true, force: true });

  opts.db.run(`UPDATE title SET role = 'main', output_path = ? WHERE id = ?`, [
    paths.mainMkv,
    opts.mainTitle.id,
  ]);
  opts.db.run(`UPDATE disc SET status = 'remuxed', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    opts.disc.id,
  ]);

  return { outputPath: paths.mainMkv, skipped: false, logPath };
}

// -----------------------------------------------------------------------
// TV path
// -----------------------------------------------------------------------

export type TvRemuxOpts = {
  db: DB;
  outDir: string;
  makemkvcon: string;
  discRoot: string;
  disc: DiscRow;
  show: TvShowRow;
  season: SeasonRow;
  episodeMap: Array<{ title: TitleRow; episode: EpisodeRow }>;
  runId: number;
  force: boolean;
  shortFp: string;
  // Called per progress tick. `epIdx` is 1-based.
  onProgress?: (epIdx: number, epTotal: number, frac: number, task?: string) => void;
  // Called when an episode finishes (after newline). Used by the CLI to
  // reset the line buffer between episodes.
  onEpisodeDone?: (epIdx: number, epTotal: number, skipped: boolean) => void;
};

export type TvRemuxResult = {
  outputs: Array<{
    title: TitleRow;
    episode: EpisodeRow;
    outputPath: string;
    skipped: boolean;
  }>;
  logPath: string;
};

export async function remuxTvEpisodes(opts: TvRemuxOpts): Promise<TvRemuxResult> {
  const showIdentity: TvIdentity = {
    showName: opts.show.name,
    firstAirYear: opts.show.first_air_year,
    imdb_id: opts.show.imdb_id,
    tmdb_id: opts.show.tmdb_id,
  };

  const logDir = join(opts.outDir, ".bdremuxer", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${opts.shortFp}-${opts.runId}.log`);
  setRunLogPath(opts.db, opts.runId, logPath);

  const outputs: TvRemuxResult["outputs"] = [];
  const total = opts.episodeMap.length;

  for (let i = 0; i < opts.episodeMap.length; i++) {
    const { title, episode } = opts.episodeMap[i]!;
    const paths = plexTvPaths(opts.outDir, showIdentity, {
      seasonNumber: opts.season.season_number,
      episodeNumber: episode.episode_number,
      episodeName: episode.name,
    });

    if (!opts.force && existsSync(paths.episodeMkv)) {
      opts.db.run(
        `UPDATE title SET role = 'episode', episode_id = ?, output_path = ? WHERE id = ?`,
        [episode.id, paths.episodeMkv, title.id],
      );
      outputs.push({ title, episode, outputPath: paths.episodeMkv, skipped: true });
      opts.onEpisodeDone?.(i + 1, total, true);
      continue;
    }

    mkdirSync(paths.seasonFolder, { recursive: true });

    const tmpDir = join(
      opts.outDir,
      ".bdremuxer",
      "tmp",
      opts.shortFp,
      `title-${title.makemkv_id}`,
    );
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });

    await runMkv({
      makemkvcon: opts.makemkvcon,
      source: `file:${opts.discRoot}`,
      titleId: title.makemkv_id,
      outputDir: tmpDir,
      logPath,
      onProgress: opts.onProgress
        ? (frac, task) => opts.onProgress!(i + 1, total, frac, task)
        : undefined,
    });

    const produced = readdirSync(tmpDir)
      .filter((n) => n.toLowerCase().endsWith(".mkv"))
      .map((n) => join(tmpDir, n))
      .sort((a, b) => statSync(b).size - statSync(a).size);

    if (produced.length === 0) {
      throw new Error(
        `makemkvcon produced no MKV files in ${tmpDir} for title ${title.makemkv_id}. See log: ${logPath}`,
      );
    }

    rmSync(paths.episodeMkv, { force: true });
    renameSync(produced[0]!, paths.episodeMkv);
    rmSync(tmpDir, { recursive: true, force: true });

    opts.db.run(
      `UPDATE title SET role = 'episode', episode_id = ?, output_path = ? WHERE id = ?`,
      [episode.id, paths.episodeMkv, title.id],
    );
    outputs.push({ title, episode, outputPath: paths.episodeMkv, skipped: false });
    opts.onEpisodeDone?.(i + 1, total, false);
  }

  opts.db.run(`UPDATE disc SET status = 'remuxed', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    opts.disc.id,
  ]);

  return { outputs, logPath };
}
