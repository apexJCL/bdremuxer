# bdremuxer

A CLI tool that automates the remuxing of Blu-ray Disc movies **and TV
box-sets** into a tidy library of MKV files annotated with metadata fetched
from online sources.

---

## 1. Goals

- Given a Blu-ray source (BDMV folder), produce one or more MKV files that
  represent the main feature(s) and any auxiliary titles worth keeping.
    - **Movie discs** → one MKV for the main feature, plus optional extras.
    - **TV box-set discs** → one MKV per episode, plus optional extras.
- Identify the title automatically (best-effort) and enrich it with metadata
  from external APIs (TMDB primary, OMDb fallback). Movies use TMDB
  `/search/movie`; TV uses TMDB `/search/tv` + `/tv/{id}/season/{n}`.
- Persist the metadata and processing history in a local SQLite database so
  subsequent runs can resume, dedupe, or re-export without re-querying APIs.
- Produce an output directory laid out so it can be dropped straight into a
  Plex/Jellyfin/Kodi library.
- Support **batch mode**: point at a parent directory containing many BDMV
  folders and process them in sequence (useful for box-sets spanning
  multiple discs).

## 2. Non-goals (initial scope)

- No transcoding — we are remuxing only (lossless container swap).
- No track/subtitle filtering — every track from the chosen titles is kept.
  (Filtering is a likely follow-up; the schema should leave room for it.)
- No GUI. CLI only.
- No ISO/raw-disc ingestion — caller must mount the disc and point at the
  BDMV folder. (ISO support is a clean follow-up.)
- No DRM circumvention beyond what MakeMKV already handles.
- No writing into the MKV header (`mkvpropedit`) in v1 — leave headers as
  MakeMKV produces them; revisit later if needed.

## 3. Inputs

- **Path to a BDMV directory** (positional arg). Must contain `BDMV/index.bdmv`.
- **Output directory** (`--out`, default `./out`).
- **Config file** (`--config`, default `~/.config/bdremuxer/config.toml`)
  carrying API keys and user defaults.
- **Media-type hint** (`--type movie|tv|auto`, default `auto`). `auto`
  uses the title-pattern heuristic in §5.3 to decide.
- **Movie identification hints**
    - `--title "The Thing (1982)"` — skip search, use this as the query.
    - `--tmdb-id N` / `--imdb-id ttN` — skip search entirely, hit the
      `/movie/{id}` endpoint directly.
- **TV identification hints**
    - `--show "Breaking Bad (2008)"` — search query for the show.
    - `--tmdb-show-id N` — skip show search.
    - `--season N` — season number this disc belongs to. Required for TV
      unless we can parse it from the volume label or parent directory
      (e.g. `BREAKING_BAD_S2_D3`, `Breaking Bad - Season 2 - Disc 3`).
    - `--starting-episode N` (default `1`) — for multi-disc seasons, the
      episode number that maps to the *first* episode-like title on this
      disc.
    - `--episode-order broadcast|production|dvd` (default `broadcast`) —
      which TMDB episode ordering to use when mapping titles → episodes.
- **Batch entry** — `bdremuxer batch <parent-dir>` walks the tree for
  `BDMV/index.bdmv` files and runs the per-disc pipeline against each in
  lexical order. All other flags apply to every disc in the batch; per-disc
  overrides come from a sidecar `bdremuxer.toml` placed alongside the BDMV
  folder (same keys as CLI flags).

## 4. Outputs

Layout is selectable via `--output-format`:

- `plex` (default) — Plex naming convention, separate folder per title.
- `flat` — dump every selected title into `<out>/` with a deterministic
  filename. No subdirectories. Useful for triage / inspection.
- `jellyfin`, `kodi` — reserved names; not implemented in v1, will alias
  to `plex` until tightened up.

Per-disc manifests live under a hidden `.bdremuxer/manifests/<disc-fp>.json`
directory at the library root, *not* inside the title directory. This keeps
movie folders clean and prevents multi-disc TV seasons from clobbering each
other's manifests.

### 4.1 Movie disc — `plex`

```
<out>/<Movie Title> (<Year>) [imdbid-tt0084787]/
  ├── <Movie Title> (<Year>).mkv          ← main feature
  └── extras/                              ← only if --include-extras
        ├── title_03.mkv
        └── title_05.mkv
<out>/.bdremuxer/manifests/<disc-fp>.json
```

### 4.2 TV disc — `plex`

```
<out>/<Show Title> (<Year>) [tmdbid-1396]/
  └── Season 02/
        ├── <Show Title> - S02E01 - <Episode Title>.mkv
        ├── <Show Title> - S02E02 - <Episode Title>.mkv
        ├── …
        └── extras/                        ← season-level extras (only if --include-extras)
              └── title_07.mkv
<out>/.bdremuxer/manifests/<disc-fp>.json
```

Multiple discs in the same season merge naturally into the same
`Season NN/` directory across separate runs. Each disc gets its own
manifest under `.bdremuxer/manifests/`, keyed by the disc fingerprint
(short hash, e.g. first 12 hex chars).

### 4.3 Flat layout

```
<out>/<source-disc-name>__title_<NN>.mkv
<out>/<source-disc-name>__title_<NN>.json   ← sidecar per title
```

### 4.4 Common

- The `[imdbid-…]` / `[tmdbid-…]` tag is omitted when the external ID
  can't be resolved.
- Episode titles missing from TMDB collapse to `Episode <NN>`.
- The SQLite DB lives at `<out>/.bdremuxer.sqlite` by default (overridable
  in config). It is the source of truth across runs.

## 5. Pipeline

Each invocation runs these stages in order. Each stage's result is persisted
so a re-run can resume from the last successful stage.

### 5.1 Scan

Verify the BDMV path, compute a stable disc fingerprint (hash of
`BDMV/index.bdmv` + sorted list of `.m2ts` sizes), record a `disc` row.

### 5.2 Probe

Run `makemkvcon -r --cache=1 info file:<path>` and parse the robot-output
title list (duration, size, segment map, audio/subtitle tracks). Persist as
`title` and `track` rows.

### 5.3 Classify (movie vs TV)

If `--type` is set explicitly, use it. Otherwise:

- Count titles ≥ `min-length-skip` (default 90s) after dropping playlists
  that are concatenations of other titles.
- Compute the duration spread of the longest 3+ titles.
- **TV indicators**: ≥ 3 titles within ±15 % of each other AND the volume
  label / parent dir matches `/season|s\d{1,2}|disc \d/i`.
- **Movie indicators**: one clearly-dominant title (≥ 1.5× the next).
- Ambiguous → abort with a message asking for `--type`.

### 5.4 Identify

Direct-ID flags always win — if `--tmdb-id` / `--imdb-id` / `--tmdb-show-id`
is set, skip search entirely and hit the corresponding TMDB by-id endpoint.

**Movie path.** Search query priority (when no ID flag): `--title` → disc
volume label → BDMV parent directory name. Query TMDB `/search/movie`; on
empty result, fall back to OMDb.

**TV path.** Show search query priority (when no ID flag): `--show` →
volume label / parent dir with season suffix stripped. Query TMDB
`/search/tv`. Once the show is resolved, the season must be known: read
`--season`, then attempt to parse it from the volume label / parent dir
(via `parse/season-hint.ts`), otherwise abort with a clear error. Then
fetch `/tv/{id}/season/{season}` to get the full episode list (with the
requested `--episode-order`).

**Ambiguity rule.** If multiple candidates score within 10 % of the top
match, print a brief numbered listing (title, year, popularity, TMDB id)
and abort with a hint to pass `--tmdb-id` / `--tmdb-show-id`. No
interactive prompt — we want batch mode to remain non-interactive.

Persist the resolved entity into `movie` *or* `tv_show`+`season`, with the
raw API response as a JSON blob.

### 5.5 Select titles

Common pre-filter (applied first, both paths):

- Drop any title shorter than `--min-length-skip` (default `90s`; accepts
  `90s`, `5m`, `1h`; `false` disables filtering entirely).
- Drop play-all playlists: titles whose segment map equals the
  concatenation of segment maps of two or more other titles, and whose
  duration is within ±2s of their sum.

**Movie path.**

- Main feature: longest remaining title within 90–110 % of TMDB's runtime
  when known; otherwise longest overall.
- With `--include-extras`: also keep every remaining title.

**TV path.**

- Identify the **episode cohort**: cluster the remaining titles by
  duration; the largest cluster whose member count matches (or is close
  to) the season's episode count on this disc is the cohort. Tie-break by
  picking the cluster with the longest median.
- **Outlier inclusion.** If exactly one surviving title outside the cohort
  has a duration within ±40 % of the cohort's median, AND the cohort
  itself is tight (stdev < 10 % of median), pull that outlier in as an
  episode too. This catches feature-length season finales sitting on the
  same disc as a tight cluster of standard-length episodes.
- Map cohort titles (including the pulled-in outlier, if any) to TMDB
  episodes in disc order, starting at `--starting-episode`. Record the
  mapping (`title.episode_id`).
- Any remaining title that survived the pre-filter is an extra; included
  only when `--include-extras`.
- **Note on play-all detection.** The pre-filter only catches play-all
  playlists that are literal segment-map concatenations within ±2s.
  Playlists built with chapter transitions or alternate audio mixes will
  slip through and surface as an "extra". This is a known limitation —
  easier for the user to delete one extra MKV than for us to ship a
  fancier detector that occasionally drops a real episode.

### 5.6 Remux

Invoke `makemkvcon mkv file:<path> <title-id> <tmp-dir>` for each selected
title. Stream `--robot` progress to stderr. On success, move into the
output layout with the final name from §4.

### 5.7 Finalize

Write the per-disc manifest at `<out>/.bdremuxer/manifests/<disc-fp>.json`
(contents: disc fingerprint, resolved movie/show/season/episode IDs,
title→output mapping, run id). Update the DB with output paths, set
`disc.status = 'done'`.

Any stage failure marks the disc with a `failed_at_stage` so a re-run picks
up from there.

## 6. CLI surface

```
bdremuxer <BDMV path> [global flags] [identification flags] [selection flags]

bdremuxer batch <parent-dir> [global flags] [identification flags] [selection flags]
                             [--continue-on-error]   ← keep going after a disc fails

# global flags
  --out DIR
  --config FILE
  --output-format plex|flat|jellyfin|kodi   (default: plex)
  --makemkvcon PATH
  --dry-run                  ← stop after §5.5 (select), print plan
  --force                    ← re-run even if disc.status=done
  --json                     ← machine-readable progress on stdout
  -v | -vv                   ← log verbosity

# identification flags
  --type movie|tv|auto       (default: auto)
  --title "Name (Year)"      (movie)
  --tmdb-id N                (movie)
  --imdb-id ttN              (movie)
  --show "Name (Year)"       (tv)
  --tmdb-show-id N           (tv)
  --season N                 (tv; required if not parseable)
  --starting-episode N       (tv; default 1)
  --episode-order broadcast|production|dvd   (tv; default broadcast)

# selection flags
  --include-extras
  --min-length-skip <N>(s|m|h) | false    (default: 90s)
```

Subcommands (later, not v1): `bdremuxer ls`, `bdremuxer reidentify <disc>`,
`bdremuxer export-nfo`.

## 7. Configuration

`~/.config/bdremuxer/config.toml`:

```toml
[apis]
tmdb_api_key = "..."
omdb_api_key = "..."          # optional

[paths]
output_dir = "~/Media/Movies"
db_path = "~/Library/Application Support/bdremuxer/library.sqlite"
makemkvcon = "/Applications/MakeMKV.app/Contents/MacOS/makemkvcon"
# optional — falls back to $MAKEMKVCON, then $PATH

[defaults]
include_extras = false
min_length_skip = "90s"                   # or `false` to keep everything
output_format = "plex"
episode_order = "broadcast"             # for TV
language_preference = ["eng", "jpn"]          # informational for now
```

Env-var overrides: `BDREMUXER_TMDB_API_KEY`, `BDREMUXER_OUTPUT_DIR`,
`MAKEMKVCON`, etc.

### 7.1 Per-disc overrides (batch mode)

When running `bdremuxer batch`, overrides can be supplied two ways. Keys
are `snake_case`, matching the main `[defaults]` block; the equivalent of
each CLI flag is the same name with hyphens replaced by underscores.

**Sidecar TOML.** A `bdremuxer.toml` placed next to a specific BDMV folder
overrides flags for that disc only:

```toml
type = "tv"
show = "Breaking Bad (2008)"
season = 2
starting_episode = 1
include_extras = true
```

**Top-level batch TOML.** A `bdremuxer.batch.toml` at the root of the
parent directory passed to `bdremuxer batch` lets one file describe many
discs by globbing their subdirectory names:

```toml
[apis]
# inherits from ~/.config/bdremuxer/config.toml; override here if needed

["Breaking Bad - S2*"]
type = "tv"
show = "Breaking Bad (2008)"
season = 2
include_extras = true

["Breaking Bad - S2 - Disc 1"]
starting_episode = 1

["Breaking Bad - S2 - Disc 2"]
starting_episode = 4

["Breaking Bad - S2 - Disc 3"]
starting_episode = 8

["Movies/*"]
type = "movie"
```

Resolution order (last wins): config defaults → CLI flags → matching
glob blocks in `bdremuxer.batch.toml` (most-specific glob last) → sidecar
`bdremuxer.toml`.

## 8. SQLite schema (initial)

A TV show is independent of any single disc (one show → many seasons,
one season → potentially many discs). A movie is effectively scoped to its
disc. The schema reflects that asymmetry.

```sql
CREATE TABLE disc
(
    id              INTEGER PRIMARY KEY,
    fingerprint     TEXT UNIQUE NOT NULL,
    source_path     TEXT        NOT NULL,
    volume_label    TEXT,
    media_kind      TEXT        NOT NULL CHECK (media_kind IN ('movie', 'tv')),
    movie_id        INTEGER REFERENCES movie (id),
    season_id       INTEGER REFERENCES season (id),
    status          TEXT        NOT NULL CHECK (status IN (
                                                           'scanned', 'probed', 'classified', 'identified',
                                                           'selected', 'remuxed', 'done', 'failed')),
    failed_at_stage TEXT,
    created_at      TEXT        NOT NULL,
    updated_at      TEXT        NOT NULL,
    -- Whichever FK matches media_kind may be NULL (still in earlier stages)
    -- or set (after identify); the opposite FK must always be NULL.
    CHECK (
        (media_kind = 'movie' AND season_id IS NULL) OR
        (media_kind = 'tv' AND movie_id IS NULL)
        )
);

CREATE TABLE movie
(
    id           INTEGER PRIMARY KEY,
    tmdb_id      INTEGER UNIQUE,
    imdb_id      TEXT UNIQUE,
    title        TEXT NOT NULL,
    year         INTEGER,
    runtime_min  INTEGER,
    raw_response TEXT -- JSON blob from TMDB/OMDb
);

CREATE TABLE tv_show
(
    id             INTEGER PRIMARY KEY,
    tmdb_id        INTEGER UNIQUE,
    imdb_id        TEXT UNIQUE,
    name           TEXT NOT NULL,
    first_air_year INTEGER,
    raw_response   TEXT
);

CREATE TABLE season
(
    id            INTEGER PRIMARY KEY,
    tv_show_id    INTEGER NOT NULL REFERENCES tv_show (id),
    season_number INTEGER NOT NULL,
    episode_order TEXT    NOT NULL, -- broadcast|production|dvd
    raw_response  TEXT,
    UNIQUE (tv_show_id, season_number, episode_order)
);

CREATE TABLE episode
(
    id             INTEGER PRIMARY KEY,
    season_id      INTEGER NOT NULL REFERENCES season (id),
    episode_number INTEGER NOT NULL,
    name           TEXT,
    runtime_min    INTEGER,
    air_date       TEXT,
    raw_response   TEXT,
    UNIQUE (season_id, episode_number)
);

CREATE TABLE title
(                                                -- a MakeMKV title on the disc
    id          INTEGER PRIMARY KEY,
    disc_id     INTEGER NOT NULL REFERENCES disc (id),
    makemkv_id  INTEGER NOT NULL,
    duration_s  INTEGER NOT NULL,
    size_bytes  INTEGER NOT NULL,
    segment_map TEXT,                            -- e.g. "00800+00801+00802"
    role        TEXT    NOT NULL,                -- main|episode|extra|skipped
    episode_id  INTEGER REFERENCES episode (id), -- set when role=episode
    output_path TEXT,
    UNIQUE (disc_id, makemkv_id)
);

CREATE TABLE track
(
    id       INTEGER PRIMARY KEY,
    title_id INTEGER NOT NULL REFERENCES title (id),
    kind     TEXT    NOT NULL, -- video|audio|subtitle
    codec    TEXT,
    language TEXT,
    channels INTEGER,
    flags    TEXT              -- comma list: default,forced,commentary…
);

CREATE TABLE run
(
    id          INTEGER PRIMARY KEY,
    disc_id     INTEGER NOT NULL REFERENCES disc (id),
    started_at  TEXT    NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    log_path    TEXT
);
```

Notes:

- `disc.media_kind` plus the exclusive `movie_id` / `season_id` columns
  let a query reach the right metadata without a join discriminator hack.
- `season` carries `episode_order` so a show indexed in both broadcast
  and production order coexist cleanly.
- `episode.episode_number` is the number under the chosen ordering, not a
  global ID — the unique key reflects that.

## 9. External dependencies

- **MakeMKV** (`makemkvcon`) — required at runtime on the user's machine;
  not bundled into our binary (licensing + size). Discovery order:
    1. `--makemkvcon <path>` CLI flag (explicit override).
    2. `$MAKEMKVCON` environment variable.
    3. First `makemkvcon` found on `$PATH`.
    4. macOS fallback: `/Applications/MakeMKV.app/Contents/MacOS/makemkvcon`.

  Fail fast with a clear error if none resolve to an executable file.
- **TMDB API** — primary metadata. Free key. HTTPS, JSON.
- **OMDb API** — fallback only. Free tier (1000/day).
- **SQLite** — via Bun's built-in `bun:sqlite` (no extra install, no
  native build step, ships inside the compiled binary).

## 10. Error handling & logging

- All `makemkvcon` invocations use `--robot` parsing so we get structured
  progress lines. Raw stdout is teed to
  `<out>/.bdremuxer/logs/<disc-fp>-<run>.log`.
- Non-zero MakeMKV exit ⇒ stage marked failed, error surfaced with the
  last few `MSG:` lines.
- **API retry policy** (TMDB / OMDb):
    - Retry on network errors, HTTP 5xx, and HTTP 429 (rate limit) with
      exponential backoff: 3 tries, 1s / 2s / 4s; on 429, honour the
      `Retry-After` header if present.
    - Fail fast on HTTP 4xx other than 429 (bad request, auth, not found) —
      these don't get better with a retry.
- The tool is idempotent on success: re-running a finished disc is a no-op
  unless `--force`.

## 11. Project layout (proposal)

**Language / runtime: TypeScript on Bun.** Distribution is a single
standalone executable produced via `bun build --compile`, so end users do
not need Bun (or Node) installed — just `makemkvcon` on the PATH. Bun's
built-in `bun:sqlite` covers the database with no native build step, and
`Bun.spawn` handles `makemkvcon` subprocess wrangling cleanly.

Tooling: `tsc --noEmit` for type-checking, `biome` (or `eslint` +
`prettier`) for lint/format, `bun test` for tests.

Target platform (v1): **macOS only**.

- Primary build: `--target=bun-darwin-arm64` → `bdremuxer-macos-arm64`
- Secondary build (same source, no code changes): `--target=bun-darwin-x64`
  → `bdremuxer-macos-x64`. Enable only if/when we have an Intel user.

Linux / Windows builds are intentionally out of scope for v1 but the code
should avoid hard-coded paths so adding them later is a CI matrix change,
not a refactor.

Build invocation:

```
bun build ./src/cli.ts \
  --compile \
  --minify \
  --sourcemap \
  --target=bun-darwin-arm64 \
  --outfile dist/bdremuxer-macos-arm64
```

Repo layout:

```
bdremuxer/
  src/
    cli.ts              # entry point — argv parsing, command dispatch
    batch.ts            # `bdremuxer batch` walker + per-disc override loader
    config.ts
    db.ts               # bun:sqlite schema + migrations
    pipeline/
      scan.ts
      probe.ts          # makemkvcon info parser
      classify.ts       # movie-vs-tv heuristic
      identify/
        index.ts        # dispatch on media_kind
        movie.ts
        tv.ts
      select/
        index.ts
        movie.ts        # main feature + extras
        tv.ts           # episode cohort detection + episode mapping
      remux.ts          # makemkvcon mkv runner (Bun.spawn)
      finalize.ts
    makemkv/
      robot.ts          # MakeMKV --robot output parser
      cli.ts            # wrapper around the makemkvcon binary
    metadata/
      tmdb.ts           # movie + tv + season endpoints
      omdb.ts
    naming/
      index.ts          # format dispatch (plex|flat|…)
      plex.ts
      flat.ts
    parse/
      season-hint.ts    # "Breaking Bad S02 Disc 3" → {show, season, disc}
      duration.ts       # "90s"|"5m"|"1h" → seconds
    log.ts
  tests/
  package.json
  tsconfig.json
  biome.json
  .github/workflows/release.yml   # cross-compile + attach artefacts
```

CLI argv parser: stick to a small dependency-light option (e.g. `citty` or
hand-rolled) — heavy frameworks bloat the compiled binary.

## 12. Milestones

1. **M1 — Walking skeleton.** Read BDMV path, run `makemkvcon info`, dump
   parsed titles to stdout. No DB, no APIs.
2. **M2 — DB + movie identify.** Persist scan/probe; TMDB movie lookup;
   print proposed movie + main title (still no remux).
3. **M3 — Remux movie main feature.** End-to-end for movie discs, main
   title only, producing the Plex-named MKV in the output dir.
4. **M4 — TV identify + classify.** `--type` flag, auto-classify heuristic,
   TMDB `/search/tv` + season fetch, episode-cohort detection, dry-run
   plan that prints the proposed episode mapping. No TV remux yet.
5. **M5 — TV remux + multi-disc seasons.** End-to-end for a TV disc,
   including `--starting-episode` and merging multiple discs into a shared
   `Season NN/` directory.
6. **M6 — Extras + resume.** `--include-extras` for both kinds, the
   `<90s` pre-filter, resume-from-stage, `--force`, structured logs.
7. **M7 — Batch + flat output.** `bdremuxer batch <parent-dir>`, per-disc
   `bdremuxer.toml` sidecars AND top-level `bdremuxer.batch.toml` glob
   blocks, `--output-format=flat`, `--continue-on-error`.
8. **M8 — Polish.** OMDb fallback, JSON progress mode, GH Actions release
   workflow producing the macOS arm64 binary, README.

## 13. Open questions

All quick-reference. Decisions resolved in earlier rounds (now baked into
the body):

- ✅ **Q1 Output layout.** Default `plex`; `--output-format=flat` available;
  `jellyfin`/`kodi` reserved but not implemented in v1.
- ✅ **Q2 Identification ambiguity.** On multiple close candidates, print a
  short numbered listing and abort with a hint to pass `--tmdb-id` /
  `--tmdb-show-id` / `--imdb-id`. No interactive prompt (keeps batch mode
  non-interactive).
- ✅ **Q3 Metadata embedding.** Not in v1; leave MKV headers as MakeMKV
  produces them.
- ✅ **Q4 Batch mode.** In v1 via `bdremuxer batch <parent-dir>`.
- ✅ **Q5 Disc fingerprint.** Hash of `index.bdmv` + sorted m2ts sizes —
  no extra hashing needed.
- ✅ **Q6 Extras filter.** Default `--min-length-skip=90s`; accepts
  `Ns|Nm|Nh` or `false` (keep everything).
- ✅ **Q7 Compile targets.** macOS arm64 only for v1.
- ✅ **Q8 Distribution.** GitHub Releases with standalone binary attached
  (deferred to M8; Homebrew tap later).
- ✅ **Q9 Auto-classify confidence.** Require explicit `--type` when the
  heuristic is unsure rather than guessing. (§5.3)
- ✅ **Q10 Episode cohort tolerance.** Pull in a single outlier within
  ±40 % of the cohort median when the cohort itself is tight (stdev
  < 10 %). Catches feature-length finales on episode discs. (§5.5)
- ✅ **Q11 Play-all detection.** Literal segment-map concat with ±2s
  duration check only; accept the occasional duplicate "extra" rather
  than risk dropping a real episode. (§5.5 note)
- ✅ **Q12 Empty TMDB episode names.** Use `Episode <NN>` placeholder; no
  TVDB fallback in v1.
- ✅ **Q13 Batch overrides.** Both supported: per-disc `bdremuxer.toml`
  sidecar AND a top-level `bdremuxer.batch.toml` with subdirectory-glob
  blocks. (§7.1)

No open questions remain — ready to start M1.
