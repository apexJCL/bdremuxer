# bdremuxer

CLI tool that automates remuxing Blu-ray Disc movies and TV box-sets into a
tidy MKV library, with TMDB-sourced metadata persisted to a local SQLite
database.

The full design — pipeline stages, schema, output layouts, open questions —
lives in [`spec.md`](./spec.md). This README is a quick-start.

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

### Batch mode

Process every BDMV folder under a parent directory:

```sh
bdremuxer batch ~/library/blu-rays --include-extras --continue-on-error
```

A few rules:

- The walker descends until it finds `BDMV/index.bdmv` and then stops
  (discs don't nest).
- Per-disc options merge in this order (last wins):
  CLI flags → matching glob blocks from `<parent>/bdremuxer.batch.toml`
  → per-disc sidecar at `<parent>/<disc>/bdremuxer.toml`.
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
| `BDREMUXER_OUTPUT_DIR`     | `./out`                                                  | output root              |
| `BDREMUXER_DB_PATH`        | `<out>/.bdremuxer.sqlite`                                | SQLite path              |
| `MAKEMKVCON`               | _(auto)_                                                 | `makemkvcon` binary      |

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
`batch_disc_start`, `batch_summary`.

Each event has at least `ts` (ISO 8601) and `kind` (the event type).

## Development

```sh
bun run dev <args>      # run from source
bun run typecheck       # tsc --noEmit
bun test                # unit tests
bun run build           # standalone macOS arm64 binary
```
