# bdremuxer

CLI tool that automates remuxing Blu-ray Disc movies and TV box-sets into a
tidy MKV library, with TMDB-sourced metadata persisted to a local SQLite
database.

The full design — pipeline stages, schema, output layouts, open questions —
lives in [`specs/spec.md`](./specs/spec.md). This README is a quick-start.

> This app is mostly a proof-of-concept, highly-driven by my own needs and implemented
> using Claude Code.
> 
> Even though I've mostly focus on fine-tuning specs, requirements, and test, I would not
> say this app is _strictly_ vibecoded.

---

## Requirements

- macOS (arm64). Linux / Windows aren't part of v1.
- [MakeMKV](https://www.makemkv.com/) installed. The `makemkvcon` binary is
  auto-discovered in this order:
  1. `--makemkvcon <path>` CLI flag
  2. `$MAKEMKVCON`
  3. anything called `makemkvcon` on `$PATH`
  4. `/Applications/MakeMKV.app/Contents/MacOS/makemkvcon`
- A TMDB API key (free, signup at <https://www.themoviedb.org/settings/api>).
  Optional: an OMDb key for fallback identification.
- [Bun](https://bun.com) — only for building from source. The compiled
  binary has no runtime dependency beyond `makemkvcon`.

## Build

```sh
bun install
bun run build           # → dist/bdremuxer-macos-arm64
```

The compiled binary is fully standalone (Bun + the dep tree are bundled in).

## Run

```sh
# minimum invocation
export BDREMUXER_TMDB_API_KEY=...
bdremuxer /Volumes/THE_THING

# explicit movie identification (skips TMDB search)
bdremuxer /Volumes/SOME_DISC --tmdb-id 1091
bdremuxer /Volumes/SOME_DISC --imdb-id tt0084787
bdremuxer /Volumes/SOME_DISC --title "The Thing (1982)"

# TV box-set disc 3 of season 2, episodes 5+
bdremuxer "/Volumes/BREAKING_BAD_S2_D3" \
  --type tv --show "Breaking Bad" --season 2 --starting-episode 5

# inspect the plan without remuxing
bdremuxer /Volumes/SOME_DISC --dry-run

# include extras
bdremuxer /Volumes/SOME_DISC --include-extras

# don't filter shorts at all (default is to skip < 90s)
bdremuxer /Volumes/SOME_DISC --min-length-skip false

# write to a flat directory instead of Plex-style folders
bdremuxer /Volumes/SOME_DISC --output-format flat
```

### ISO files

Point at a `.iso` file the same way you'd point at a BDMV folder. The
tool mounts the image transparently for the duration of the run and
detaches on exit:

```sh
bdremuxer ~/library/MY_DISC.iso
bdremuxer batch ~/library/blu-rays   # finds .iso files alongside BDMV/ folders
```

Per-ISO overrides live in `<basename>.bdremuxer.toml` next to the file
(e.g. `MY_DISC.bdremuxer.toml` for `MY_DISC.iso`). When an ISO sits alone
in its parent directory a plain `bdremuxer.toml` next to it also works,
but not when sibling ISOs share the directory — that's ambiguous, so the
named form is required.

ISO support is macOS-only in v1 (uses `hdiutil`). The image is mounted
read-only under `$TMPDIR/bdremuxer-mounts/`; `Ctrl-C` or a crash mid-run
detaches every live mount before the process exits, and a defensive
sweep at startup catches anything a previous `kill -9` left behind.
(The mount root has to live on the boot volume — macOS's mount helper
refuses to create mount points on Thunderbolt / USB drives.) Encrypted
ISO images are not supported.

Design notes: [`specs/spec-iso.md`](./specs/spec-iso.md).

### Batch mode

Process every BDMV folder under a parent directory:

```sh
bdremuxer batch ~/library/blu-rays --include-extras --continue-on-error
```

By default, batch runs in two phases — plan first, rip second:

```
[plan]
  Walking 6 disc(s) under /Volumes/library/blu-rays
  ✓ SHOW_S1D1        tv: Show Name S01 · 9 episodes (E01-E09)
  ✓ SHOW_S1D2        tv: Show Name S01 · 9 episodes (E10-E18)
  ⚠ MYSTERY_DISC     classify: top titles similar, no season hint
  → 5/6 ready · 1 blocked · 0 done · 0 stale

=== Rip 1/5 SHOW_S1D1 ===
  …
```

If anything's blocked (ambiguous TMDB hit, episode-allocation conflict,
classify ambiguity, or a `status='done'` disc whose MKVs vanished from
disk), preflight surfaces every issue together so you can fix the TOML
in one pass and re-run.

Phase-control flags:

- `--no-preflight` — process discs end-to-end as they're discovered
  (the pre-M11 behaviour). Use when you trust the TOML and want to
  bypass the planning pass.
- `--plan-only` — run preflight, print the summary, write the plan
  file at `<out>/.bdremuxer/plans/<batch-fp>.json`, and exit. Useful
  for CI gates and for previewing TOML edits before committing.
- `--confirm-plan` — prompt `Proceed?` after the plan summary, before
  any rip starts. Opt-in so unattended runs aren't blocked on stdin.

Need to scaffold the override TOML first?

```sh
# interactive wizard: walks the discs, asks per group/disc
bdremuxer init-batch ~/library/blu-rays

# or a commented-out template you can fill in by hand
bdremuxer init-batch ~/library/blu-rays --empty

# add --force to overwrite an existing bdremuxer.batch.toml
```

The wizard first asks how the directory is shaped:

- `mixed` — a library of independent titles (default). Auto-detects
  `(show, season)` groups (e.g. `Breaking Bad - S2 - Disc 1/2/3`) and
  asks once per group / once per singleton.
- `tv-boxset` — every disc belongs to one TV show. Asks show + TMDB id
  + extras once; the wizard buckets discs by season automatically.
- `movie-discs` — every disc belongs to one movie release. Asks title +
  TMDB id + extras once and emits one block per disc.

Per-disc `starting_episode` values are emitted as `TODO`-flagged stubs
that you fill in manually — the wizard doesn't try to guess them. Each
per-disc block is labelled with its position in the season (`Disc 2 of 3
in "Breaking Bad - S2"`) to make the relationship obvious on re-read.

After the TOML is written, `init-batch` runs a preflight pass against
the parent directory so you can see how the rules apply to each disc
before committing to a rip. Pass `--no-preflight` to skip.

A few rules:

- The walker stops descending when it finds `BDMV/index.bdmv` (discs
  don't nest). `.iso` files are recorded as their own disc entries and
  the walker keeps descending past them, so a parent can hold both ISOs
  and unpacked BDMV folders.
- Per-disc options merge in this order (last wins):
  CLI flags → matching glob blocks from `<parent>/bdremuxer.batch.toml`
  → per-disc sidecar (`<parent>/<disc>/bdremuxer.toml` for folder discs;
  `<parent>/<basename>.bdremuxer.toml` for ISO files).
- Without `--continue-on-error`, the loop stops at the first disc that
  fails. With it, the failed disc is logged and the loop continues.

A `bdremuxer.batch.toml` example:

```toml
["Breaking Bad - S2*"]
type             = "tv"
show             = "Breaking Bad (2008)"
season           = 2
include_extras   = true

["Breaking Bad - S2 - Disc 1"]
starting_episode = 1

["Breaking Bad - S2 - Disc 2"]
starting_episode = 4

["Movies/*"]
type             = "movie"
```

A per-disc sidecar `bdremuxer.toml`:

```toml
type             = "tv"
show             = "Breaking Bad (2008)"
season           = 2
starting_episode = 1
include_extras   = true
```

TOML keys are the snake_case versions of the CLI flag names.

## Output layouts

### `plex` (default)

```
out/
  The Thing (1982) [imdbid-tt0084787]/
    The Thing (1982).mkv
    extras/                                  # only with --include-extras
      title_03.mkv
  Breaking Bad (2008) [imdbid-tt0903747]/
    Season 02/
      Breaking Bad - S02E01 - Seven Thirty-Seven.mkv
      Breaking Bad - S02E02 - Grilled.mkv
      ...
      extras/
        title_07.mkv
  .bdremuxer/
    manifests/
      abc123def456.json                       # one per disc, keyed by short fingerprint
      ...
    logs/
      abc123def456-1.log                      # raw makemkvcon stdout per run
```

### `flat`

```
out/
  THE_THING__title_00.mkv
  THE_THING__title_00.json                    # sidecar per title
  THE_THING__title_03.mkv
  THE_THING__title_03.json
  .bdremuxer/...
```

## Configuration

Most users get away with environment variables. CLI flags override env vars.

| Env var                    | Default                                                  | Used as                  |
| -------------------------- | -------------------------------------------------------- | ------------------------ |
| `BDREMUXER_TMDB_API_KEY`   | (required)                                               | TMDB key                 |
| `BDREMUXER_OMDB_API_KEY`   | (unset; OMDb fallback off)                               | OMDb key                 |
| `BDREMUXER_OUTPUT_DIR`     | _(see below)_                                            | output root              |
| `BDREMUXER_DB_PATH`        | `<out>/.bdremuxer.sqlite`                                | SQLite path              |
| `MAKEMKVCON`               | _(auto)_                                                 | `makemkvcon` binary      |

### Where output lands by default

`--out <dir>` and `$BDREMUXER_OUTPUT_DIR` both still work and override
everything. When neither is set:

- **Single-disc** (`bdremuxer /path/to/DISC`): output is a sibling of
  the input — i.e., the parent of the BDMV folder. E.g. input
  `~/library/THE_THING/` → output `~/library/`.
- **Batch** (`bdremuxer batch /path/to/library`): output is the batch
  parent directory itself. Every disc in the batch shares one library
  root, with the SQLite DB at `<library>/.bdremuxer.sqlite`.

Per-disc / batch.toml TOML overrides can still set `out = "..."` to
redirect individual discs.

## Resume behaviour

Re-running an interrupted disc picks up where it left off, automatically:

- If title rows are already cached in the DB, the probe stage is skipped.
- Per-title remux is skipped when the target MKV exists.
- A previously-completed disc (`status='done'`) exits 0 without doing
  anything; pass `--force` to redo it.
- `--force` also drops the cached titles, forcing a fresh probe.

## JSON output

```sh
bdremuxer /Volumes/SOME_DISC --json
```

Emits NDJSON events on stdout instead of the human-friendly summaries.
Events: `already_done`, `plan`, `progress`, `title_done`, `done`,
`error`, `ambiguous_match`, plus batch-level `batch_start`,
`batch_disc_start`, `batch_summary`, and preflight `preflight_start`,
`preflight_disc_planned`, `preflight_summary`.

Each event has at least `ts` (ISO 8601) and `kind` (the event type).

## Development

```sh
bun run dev <args>      # run from source
bun run typecheck       # tsc --noEmit
bun test                # unit tests
bun run build           # standalone macOS arm64 binary
```

## Cutting a release

CI (`.github/workflows/ci.yml`) typechecks + tests every push / PR to
`main` on a macOS arm64 runner.

To publish a release, use the bundled helper:

```sh
bun run publish                # patch bump (0.0.1 → 0.0.2)
bun run publish minor          # 0.0.1 → 0.1.0
bun run publish major          # 0.0.1 → 1.0.0
bun run publish 1.2.3          # set exactly

bun run publish --dry-run      # print every step, don't execute
bun run publish --yes          # skip the confirmation prompt
bun run publish --branch=dev   # release from a non-main branch
```

The helper refuses to run with uncommitted changes, runs `typecheck` +
`test` before mutating anything, bumps `package.json`, commits, tags,
and pushes. If any post-bump step fails it prints concrete recovery
commands.

The release workflow (`.github/workflows/release.yml`) then runs on
the tag push. It re-runs typecheck + tests, builds the standalone
binary via `bun build --compile`, smoke-tests it (`--version` must
match `package.json`; every `--help` screen must render), and creates
a GitHub Release with `bdremuxer-macos-arm64` + its sourcemap attached.

The manual equivalent of the helper:

```sh
# edit package.json's "version" by hand, then:
git add package.json
git commit -m "Release v0.1.0"
git tag v0.1.0
git push --follow-tags
```
