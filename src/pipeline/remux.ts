// §5.6 Remux: invoke `makemkvcon mkv` for each selected title, then move
// the produced file into its final Plex-named location.
//
// Movie: main feature + (optional) extras under <folder>/extras/.
// TV:    one MKV per episode + (optional) extras under Season NN/extras/.
//
// Each per-title spawn is idempotent — if the target file already exists
// and --force isn't set, the spawn is skipped and the title is just role-
// labelled in the DB.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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

// -----------------------------------------------------------------------
// Per-title helper (shared by movie main, movie extras, TV episodes, TV extras)
// -----------------------------------------------------------------------

type RemuxOneOpts = {
  makemkvcon: string;
  discRoot: string;
  outDir: string;
  shortFp: string;
  title: TitleRow;
  targetPath: string;     // final destination after the rip succeeds
  logPath: string;
  force: boolean;
  onProgress?: (frac: number, task?: string) => void;
};

type RemuxOneResult = { outputPath: string; skipped: boolean };

async function remuxOneTitle(opts: RemuxOneOpts): Promise<RemuxOneResult> {
  if (!opts.force && existsSync(opts.targetPath)) {
    return { outputPath: opts.targetPath, skipped: true };
  }

  mkdirSync(dirname(opts.targetPath), { recursive: true });

  const tmpDir = join(
    opts.outDir,
    ".bdremuxer",
    "tmp",
    opts.shortFp,
    `title-${opts.title.makemkv_id}`,
  );
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  await runMkv({
    makemkvcon: opts.makemkvcon,
    source: `file:${opts.discRoot}`,
    titleId: opts.title.makemkv_id,
    outputDir: tmpDir,
    logPath: opts.logPath,
    onProgress: opts.onProgress,
  });

  const produced = readdirSync(tmpDir)
    .filter((n) => n.toLowerCase().endsWith(".mkv"))
    .map((n) => join(tmpDir, n))
    .sort((a, b) => statSync(b).size - statSync(a).size);

  if (produced.length === 0) {
    throw new Error(
      `makemkvcon produced no MKV files in ${tmpDir} for title ${opts.title.makemkv_id}. See log: ${opts.logPath}`,
    );
  }

  rmSync(opts.targetPath, { force: true });
  renameSync(produced[0]!, opts.targetPath);
  rmSync(tmpDir, { recursive: true, force: true });

  return { outputPath: opts.targetPath, skipped: false };
}

function extrasFileName(makemkvId: number): string {
  return `title_${makemkvId.toString().padStart(2, "0")}.mkv`;
}

function setupLog(outDir: string, shortFp: string, runId: number, db: DB): string {
  const logDir = join(outDir, ".bdremuxer", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${shortFp}-${runId}.log`);
  setRunLogPath(db, runId, logPath);
  return logPath;
}

// -----------------------------------------------------------------------
// Movie path
// -----------------------------------------------------------------------

export type MovieRemuxOpts = {
  db: DB;
  outDir: string;
  makemkvcon: string;
  discRoot: string;
  disc: DiscRow;
  movie: MovieRow;
  mainTitle: TitleRow;
  extras: TitleRow[];        // empty when --include-extras is off
  runId: number;
  force: boolean;
  shortFp: string;
  onMainProgress?: (frac: number, task?: string) => void;
  onExtraProgress?: (idx: number, total: number, frac: number, task?: string) => void;
  onTitleDone?: (kind: "main" | "extra", idx: number, total: number, skipped: boolean) => void;
};

export type MovieRemuxResult = {
  main: { title: TitleRow; outputPath: string; skipped: boolean };
  extras: Array<{ title: TitleRow; outputPath: string; skipped: boolean }>;
  logPath: string;
};

export async function remuxMovieMain(opts: MovieRemuxOpts): Promise<MovieRemuxResult> {
  const identity: MovieIdentity = {
    title: opts.movie.title,
    year: opts.movie.year,
    imdb_id: opts.movie.imdb_id,
    tmdb_id: opts.movie.tmdb_id,
  };
  const paths = plexMoviePaths(opts.outDir, identity);
  const logPath = setupLog(opts.outDir, opts.shortFp, opts.runId, opts.db);

  mkdirSync(paths.folder, { recursive: true });

  // Main feature
  const main = await remuxOneTitle({
    makemkvcon: opts.makemkvcon,
    discRoot: opts.discRoot,
    outDir: opts.outDir,
    shortFp: opts.shortFp,
    title: opts.mainTitle,
    targetPath: paths.mainMkv,
    logPath,
    force: opts.force,
    onProgress: opts.onMainProgress,
  });
  opts.db.run(`UPDATE title SET role = 'main', output_path = ? WHERE id = ?`, [
    main.outputPath,
    opts.mainTitle.id,
  ]);
  opts.onTitleDone?.("main", 1, 1, main.skipped);

  // Extras
  const extrasOut: MovieRemuxResult["extras"] = [];
  for (let i = 0; i < opts.extras.length; i++) {
    const t = opts.extras[i]!;
    const targetPath = join(paths.extrasDir, extrasFileName(t.makemkv_id));
    const res = await remuxOneTitle({
      makemkvcon: opts.makemkvcon,
      discRoot: opts.discRoot,
      outDir: opts.outDir,
      shortFp: opts.shortFp,
      title: t,
      targetPath,
      logPath,
      force: opts.force,
      onProgress: opts.onExtraProgress
        ? (frac, task) => opts.onExtraProgress!(i + 1, opts.extras.length, frac, task)
        : undefined,
    });
    opts.db.run(`UPDATE title SET role = 'extra', output_path = ? WHERE id = ?`, [
      res.outputPath,
      t.id,
    ]);
    extrasOut.push({ title: t, outputPath: res.outputPath, skipped: res.skipped });
    opts.onTitleDone?.("extra", i + 1, opts.extras.length, res.skipped);
  }

  opts.db.run(`UPDATE disc SET status = 'remuxed', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    opts.disc.id,
  ]);

  return {
    main: { title: opts.mainTitle, outputPath: main.outputPath, skipped: main.skipped },
    extras: extrasOut,
    logPath,
  };
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
  extras: TitleRow[];
  runId: number;
  force: boolean;
  shortFp: string;
  onEpisodeProgress?: (epIdx: number, epTotal: number, frac: number, task?: string) => void;
  onExtraProgress?: (idx: number, total: number, frac: number, task?: string) => void;
  onTitleDone?: (kind: "episode" | "extra", idx: number, total: number, skipped: boolean) => void;
};

export type TvRemuxResult = {
  episodes: Array<{
    title: TitleRow;
    episode: EpisodeRow;
    outputPath: string;
    skipped: boolean;
  }>;
  extras: Array<{ title: TitleRow; outputPath: string; skipped: boolean }>;
  logPath: string;
};

export async function remuxTvEpisodes(opts: TvRemuxOpts): Promise<TvRemuxResult> {
  const showIdentity: TvIdentity = {
    showName: opts.show.name,
    firstAirYear: opts.show.first_air_year,
    imdb_id: opts.show.imdb_id,
    tmdb_id: opts.show.tmdb_id,
  };
  const logPath = setupLog(opts.outDir, opts.shortFp, opts.runId, opts.db);

  // Episodes
  const episodesOut: TvRemuxResult["episodes"] = [];
  const epTotal = opts.episodeMap.length;
  for (let i = 0; i < opts.episodeMap.length; i++) {
    const { title, episode } = opts.episodeMap[i]!;
    const paths = plexTvPaths(opts.outDir, showIdentity, {
      seasonNumber: opts.season.season_number,
      episodeNumber: episode.episode_number,
      episodeName: episode.name,
    });
    const res = await remuxOneTitle({
      makemkvcon: opts.makemkvcon,
      discRoot: opts.discRoot,
      outDir: opts.outDir,
      shortFp: opts.shortFp,
      title,
      targetPath: paths.episodeMkv,
      logPath,
      force: opts.force,
      onProgress: opts.onEpisodeProgress
        ? (frac, task) => opts.onEpisodeProgress!(i + 1, epTotal, frac, task)
        : undefined,
    });
    opts.db.run(
      `UPDATE title SET role = 'episode', episode_id = ?, output_path = ? WHERE id = ?`,
      [episode.id, res.outputPath, title.id],
    );
    episodesOut.push({ title, episode, outputPath: res.outputPath, skipped: res.skipped });
    opts.onTitleDone?.("episode", i + 1, epTotal, res.skipped);
  }

  // Extras (placed under Season NN/extras/ — needs any plexTvPaths to get the dir)
  const extrasOut: TvRemuxResult["extras"] = [];
  if (opts.extras.length > 0) {
    const samplePaths = plexTvPaths(opts.outDir, showIdentity, {
      seasonNumber: opts.season.season_number,
      episodeNumber: 1,
      episodeName: null,
    });
    for (let i = 0; i < opts.extras.length; i++) {
      const t = opts.extras[i]!;
      const targetPath = join(samplePaths.extrasDir, extrasFileName(t.makemkv_id));
      const res = await remuxOneTitle({
        makemkvcon: opts.makemkvcon,
        discRoot: opts.discRoot,
        outDir: opts.outDir,
        shortFp: opts.shortFp,
        title: t,
        targetPath,
        logPath,
        force: opts.force,
        onProgress: opts.onExtraProgress
          ? (frac, task) => opts.onExtraProgress!(i + 1, opts.extras.length, frac, task)
          : undefined,
      });
      opts.db.run(`UPDATE title SET role = 'extra', output_path = ? WHERE id = ?`, [
        res.outputPath,
        t.id,
      ]);
      extrasOut.push({ title: t, outputPath: res.outputPath, skipped: res.skipped });
      opts.onTitleDone?.("extra", i + 1, opts.extras.length, res.skipped);
    }
  }

  opts.db.run(`UPDATE disc SET status = 'remuxed', updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    opts.disc.id,
  ]);

  return { episodes: episodesOut, extras: extrasOut, logPath };
}
