# bdremuxer — preflight pass (M11)

Companion to [`spec.md`](./spec.md). This file scopes a single feature:
making `bdremuxer batch <parent-dir>` (and the `init-batch` wizard)
two-phase by default — *plan first, rip second* — so users can spot
glob mis-matches, ambiguous TMDB hits, missing `starting_episode`
values, and stale `status='done'` rows before any rip starts.

The rest of the architecture in `spec.md` is unchanged.

---

## 1. Goals

1. Surface metadata/configuration mistakes *before* the optical drive is
   tied up for hours.
2. Reuse cached pipeline state: the cost of running the planning stages
   (scan / probe / classify / identify / select) up front is essentially
   refunded at remux time, because every stage already persists to
   SQLite and the remux phase skips probe when titles are cached.
3. Be unattended by default so batch runs still work from cron, CI, or
   "rip overnight" scenarios — opt-in confirmation for users who want a
   gate.

## 2. Non-goals

- Replacing `--dry-run`. `--dry-run` is per-disc, prints a single
  proposed plan, and exits without persisting selection. Preflight is
  per-batch, persists everything that's safe to persist, and proceeds
  into the rip phase unless told otherwise.
- A separate `bdremuxer plan` subcommand. Preflight is a *phase of*
  `batch` and `init-batch`, not its own verb.
- Fixing identification or numbering automatically. Preflight surfaces
  issues; the user fixes them in `bdremuxer.batch.toml` and re-runs.
  (Conflict messages already include actionable suggestions — see
  `EpisodeAllocationConflictError`.)

## 3. UX overview

Two terminal frames the user sees during a clean batch run:

```
[plan]
  Found 6 disc(s) under /Volumes/library/show-name

  ✓ SHOW_S1D1        tv: Show Name (2020) S01 · titles 1-9   → E01-E09
  ✓ SHOW_S1D2        tv: Show Name (2020) S01 · titles 1-9   → E10-E18
  ✓ SHOW_S1D3        tv: Show Name (2020) S01 · titles 1-7   → E19-E25
  ✓ THE_THING        movie: The Thing (1982)                 → main + 2 extras
  ✓ EVIL_DEAD_II     movie: Evil Dead II (1987)              → main
  ⚠ MYSTERY_DISC     classify: ambiguous — passes through with --type

  → 5 of 6 discs ready · 1 needs attention · 0 conflicts

[rip]
  Disc 1/6 SHOW_S1D1 — E01 "Pilot"                          12%   ...
```

The plan summary above scrolls out of view once `[rip]` starts running.
That's intentional — the plan was also written to
`<out>/.bdremuxer/plans/<batch-fp>.json` for after-the-fact inspection.

When the user wants a hold point before remux begins, `--confirm-plan`
prompts:

```
  → Proceed with this plan? (y/n) [y]:
```

## 4. Two-phase batch flow

### 4.1 Phase 1 — plan

For every BDMV folder the walker finds, run *only* the read-side
stages: scan → probe → classify → identify → select. Persist what's
safe to persist:

- `disc`, `title`, `track` rows (from scan + probe).
- `tv_show`, `season`, `episode` rows (from identify) — using the
  UPSERT path we already added so multi-disc seasons don't collide.
- Title→role + title→episode links (from select).

Do *not* call `makemkvcon mkv` and do not start a `run` row. The
`disc.status` watermark advances to `selected` but never `remuxed`.

Each disc's outcome lands in one of three buckets:

- **ready** — every stage succeeded.
- **blocked** — a hard error fired (`AmbiguousTvMatchError`,
  `EpisodeAllocationConflictError`, `ClassifyError`, identify failure,
  etc.). The disc is excluded from phase 2.
- **stale-done** — `disc.status === 'done'` but at least one expected
  output MKV is missing on disk. Flagged in the plan; `--force` (or
  manual `disc.status` reset) re-includes it in phase 2.

The plan is written to `<out>/.bdremuxer/plans/<batch-fp>.json` (and
mirrored to stdout as a text summary, or as `preflight_*` NDJSON
events under `--json`).

### 4.2 Phase 2 — rip

Iterate the **ready** discs in walk order. For each one, run only
remux + finalize — every earlier stage finds its work already done in
the DB and short-circuits. `--continue-on-error` works the same way as
today; a failure in phase 2 doesn't trigger another planning pass.

`AmbiguousMatchError` and similar identify-time errors *cannot occur*
in phase 2 because identify already succeeded in phase 1. The remaining
failure modes are I/O (disc read error, disk full) and `makemkvcon`
crashes.

## 5. Issue aggregation

When phase 1 finishes, aggregate every blocked disc into a single
report instead of aborting at the first one. Example:

```
2 disc(s) need attention before remux:

  SHOW_S1D2
    EpisodeAllocationConflictError: Episodes 1-9 of "Show Name" S01 are
    already claimed by another disc (SHOW_S1D1).
    → Starting episode will be set to 10 for this disc — verify this is correct.

  MYSTERY_DISC
    ClassifyError: top titles are similar but no season hint in the
    volume label.
    → Pass --type movie or --type tv (per-disc in bdremuxer.batch.toml).

  Re-run `bdremuxer batch /Volumes/library` once you've updated the
  TOML. Discs that are already 'ready' will skip cheaply.
```

The exit code is non-zero when *any* disc is blocked, so CI / cron
notice. `--continue-on-error` is honoured: with it, the rip phase
proceeds for the **ready** subset and exits non-zero only at the end.

### 5.1 Stale `status='done'` recovery

The "MKV file missing but disc.status='done'" case (the user mentioned
manual `rm` of an output, or an interrupted finalize). Preflight checks
that every `title.output_path` referenced by `role IN ('main','episode')`
on a `status='done'` disc still exists on disk. If any is missing,
mark the disc as **stale-done** in the report and skip phase 2 unless
`--force` is set. Recovery hint emitted alongside:

```
  → SHOW_S1D1 marked 'done' but 2 output(s) missing on disk.
    Re-run with `--force` to redo this disc.
```

## 6. CLI surface

`batch` subcommand gains:

- **default behaviour** — two-phase plan→rip, unattended.
- `--confirm-plan` — prompt before phase 2 starts. Tradeoff is in §10.
- `--no-preflight` — skip phase 1 entirely (the old M8 behaviour). Use
  cases: when the user is confident, or when phase 1 itself failed for
  reasons unrelated to the discs (e.g. TMDB outage) and they want to
  proceed with the cached planning data.
- `--plan-only` — run phase 1, write the plan file, exit 0. Useful for
  CI gates ("does this batch.toml validate?") and for previewing the
  TOML edits needed before committing them.

`init-batch` gains:

- **default** — preflight runs after the wizard finishes writing the
  TOML, against the same parent dir. Same plan output, same exit-code
  semantics.
- `--no-preflight` — skip; revert to today's "write TOML and exit"
  behaviour.

Single-disc invocation (`bdremuxer /Volumes/SOME_DISC`) is unaffected;
preflight is a *batch* feature.

## 7. JSON event surface

Under `--json`, phase 1 emits:

- `preflight_start { total_discs, parent_dir }`
- `preflight_disc_planned { idx, rel_path, status: "ready"|"blocked"|"stale-done", plan }`
  where `plan` is a per-kind discriminated subset of today's `plan`
  event.
- `preflight_blocked { rel_path, reason, suggestion }` (one per
  blocked disc).
- `preflight_summary { ready, blocked, stale_done, plan_path }`

Phase 2 reuses today's `batch_disc_start` / `progress` / `title_done`
/ `done` / `error` events unchanged.

## 8. The plan file

`<out>/.bdremuxer/plans/<batch-fp>.json` shape:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-14T...Z",
  "bdremuxer_version": "0.x.y",
  "parent_dir": "/Volumes/library",
  "discs": [
    { "rel_path": "SHOW_S1D1", "status": "ready", "kind": "tv",
      "show": "Show Name (2020)", "tmdb_id": 12345, "season": 1,
      "episodes": [{ "n": 1, "title_id": 12, "name": "Pilot" }, ...],
      "extras_count": 0 },
    { "rel_path": "MYSTERY_DISC", "status": "blocked",
      "blocker": { "code": "classify_ambiguous", "message": "..." } }
  ]
}
```

`<batch-fp>` is `sha256(parent_dir + sorted rel_paths).slice(0, 12)`.
One plan file per `(parent_dir, disc set)` — re-running overwrites.

The plan file is a human-readable artefact, **not** load-bearing — the
DB is still the source of truth. Phase 2 reads from SQLite. The plan
file exists for after-the-fact inspection and for `--plan-only` /
review workflows.

## 9. Progress-UI episode briefing (small companion change)

While remuxing, the per-title progress printer already has the
`title`, `episode`, and `show` rows in memory. The progress line gains
a contextual prefix:

```
  Disc 2/6 SHOW_S1D2 — E10 "Episode Title" (22 min)               34%
```

For movies:

```
  THE_THING (1982, 109 min) — main feature   62%
```

No spec questions — minor cosmetic patch in `cli.ts`'s
`makeTvProgressPrinter` / `makeMovieProgressPrinter`. Tracked as a
follow-up to M11, not blocking.

## 10. Open questions

All resolved.

- ✅ **Q14 Confirm-plan defaulting.** `--confirm-plan` is opt-in;
  default is auto-execute. Rationale: the batch UX target is "walk
  away while the discs rip"; defaulting to prompt would surprise every
  non-TTY caller (cron, CI, headless servers). The plan summary is
  still visible scrolled up in the terminal, and the plan file remains
  on disk for after-the-fact review. Users who want a hold point pass
  one flag.

- ✅ **Q15 Offline / unreadable discs during plan.** A disc whose
  probe fails (mount went away, `makemkvcon` errors out) is recorded
  as `blocked` with reason `probe_failed` and the batch continues.
  Keeps long batches resilient; the offending disc shows up in the
  aggregated issue report at the end of phase 1.

- ✅ **Q16 Plan-file scope.** Plan file is informational only — the
  SQLite DB remains the source of truth for phase 2 resume. Making the
  plan file load-bearing would duplicate state we already track and
  force us to keep it in sync with mid-rip status changes.

- ✅ **Q17 Stale-done detection cost.** Always-on. The `statSync`
  overhead (~50-300 calls for a 50-disc library) is dwarfed by even
  the cheapest TMDB lookup, and the safety benefit of catching "MKV
  missing but `status='done'`" is high.

- ✅ **Q18 Per-disc sidecar key validation.** During plan, if a
  sidecar `bdremuxer.toml` contains an unrecognised key (e.g. a typo'd
  flag name), emit a `preflight_warning` event + a yellow-print line.
  Doesn't block; surfaces a class of silent footguns cheaply.

## 11. Implementation plan

Sketch — to be refined once the open questions above land.

1. **Phase-1 driver in `cli.ts`**: new `runPreflight(parentAbs, opts,
   discs, blocks)` that iterates the walker and calls a refactored
   `runDiscPlanning(absPath, effectiveOpts)` (essentially today's
   `runPipeline` with the rip + finalize stages skipped).
2. **`runDiscPlanning` extraction**: pull the read-side stages out of
   `runMoviePipeline` / `runTvPipeline` so they can be invoked
   independently of remux. Avoid duplication by parameterising the
   existing functions with a `mode: 'plan' | 'execute'` discriminator.
3. **Plan emission**: a pure builder (`buildBatchPlan(discs, db) →
   BatchPlan`) so the JSON file and the stdout summary share the same
   data source. Easy to unit-test.
4. **Stale-done check**: helper `findStaleDoneDiscs(db) →
   StaleDoneEntry[]` that joins `disc` × `title` and filters by
   `!existsSync(output_path)`.
5. **`--no-preflight` / `--plan-only` / `--confirm-plan`**: commander
   options on the `batch` and `init-batch` subcommands.
6. **JSON events + NDJSON schema bump**: extend the `EventKind` union
   (or whichever discriminator we have) with the four new event
   kinds. Document in README.
7. **Tests**: plan-builder unit tests, stale-done detection unit
   tests, an integration test that runs phase 1 against the existing
   robot fixture and asserts the plan shape, conflict-aggregation
   test (re-uses the M2 `episode-allocation-conflict` fixture).

A reasonable milestone shape: M11 — preflight. Progress-UI briefing
(§9) can fold into M11 or be a tiny follow-up.

## 12. M11.1 follow-ups

Real-world testing on a multi-disc TV box set surfaced three rough
edges in the M11 baseline. All three are shipped as follow-ups under
M11.1 — no schema or CLI surface changes, just better defaults.

### 12.1 Multi-segment season parsing

`parseSeasonHint` originally required a non-empty show prefix
(`Breaking Bad - S2 - Disc 3`) and anchored at end-of-string, so:

- `S1 D1` → `{}`
- `Season 1` → `{}`
- `SHOW_S1_HDBEE` → `{}` (the `_HDBEE` tail defeated the anchor)

Layouts that pack the season into the parent dir and the disc number
into the leaf (`SHOW_S1_HDBEE/S1 D1`) lost both signals. The new
parser:

- accepts a season indicator anywhere in the string with optional show
  prefix and optional trailing junk;
- exports `parseSeasonHintFromPath(relPath)` which walks every segment
  of a walker-relative path and merges the results (leaf wins on
  collisions, parent fills in fields the leaf didn't have).

The init-batch wizard and the preflight reporter both use the
multi-segment helper. Single-segment `parseSeasonHint` is still
available for callers that only have a volume label.

### 12.2 init-batch wizard: preserve inputs across un-bucketable discs

In `tv-boxset` mode, when a disc's season can't be parsed, the wizard
used to drop it into a `skipped` answer — which discarded the
just-collected `show` + `tmdb_show_id` + `include_extras` and ended up
writing the empty-comments template. The user then got an empty TOML
even though they'd answered every wizard question.

The fix: un-bucketable discs become **TV singletons** carrying the
shared `show` / `tmdb_show_id` / `include_extras`. `buildBatchBlocks`
auto-adds a `# TODO: set season = N — couldn't auto-parse the season
from this disc's path.` comment on each, so the user sees exactly
which fields are missing rather than starting from a blank file.

### 12.3 Auto-patch starting_episode from preflight back to batch.toml

The wizard emits `starting_episode = 1` placeholders on every per-disc
block. The first preflight pass identifies every season's TMDB episode
list, runs selection on every disc, and the `EpisodeAllocationConflict`
guard fires for every disc past the first in a season. Each conflict
already produced a human-readable `Set starting_episode = N` hint;
M11.1 promotes that hint to a **structured fix** the wizard can apply
back to the TOML in place.

Concretely:

- `DiscPlanBlocked` grows an optional
  `fix?: { kind: "set-starting-episode"; value: number }`.
- `planTv` populates it whenever the conflict guard has a concrete
  suggestion (`highestClaimedEpisodeInSeason + 1`).
- `init-batch` runs preflight, harvests every plan with
  `fix.kind === "set-starting-episode"`, and rewrites the matching
  block's `starting_episode = N` value in `bdremuxer.batch.toml`.
  Comments and surrounding lines survive (the patcher locates the
  block by its exact `["<rel-path>"]` header and scopes the search to
  that block).
- Preflight runs **once more** to verify the patches. Anything still
  blocked after the second pass is surfaced for manual inspection
  (we don't loop indefinitely — one re-run only).

`bdremuxer batch` does **not** auto-patch on its own. Auto-patching
runs only as the second half of `init-batch`, where the TOML was just
generated by the wizard and the user clearly hasn't put any hand-edits
in yet. If you want the same write-back behaviour during a plain
batch run, edit the TOML by hand using the suggestions printed in
the issue report.

### 12.4 selectTv: cap cohort to remaining season slots

The duration-clustering cohort detector is permissive on purpose
(±20% main + ±40% outlier inclusion) so it doesn't drop short
finales. The price is that 25-minute commentary tracks or featurettes
within that window sometimes get classified as episodes. Before
M11.1, this surfaced as a `Cohort has X titles mapping to
episodes Y-Z, but the season only has episodes up to W` throw inside
`selectTv` — a hard error that blocked the whole disc.

The new behaviour: when the cohort would map past `maxEpisodeNumber`,
trim it to fit (first N titles by `makemkv_id` order become episodes)
and demote the tail to `extras`. The demoted titles ride along even
when `--include-extras` is off, on the theory that the user wants the
bytes for triage. `TvSelection.cohortTrimmed` carries
`{ detected, seatedAsEpisode, demoted }` so the plan summary can show
a `ℹ`-marked disc with a `cohort: detected N title(s), seated M as
episodes, demoted K to extras for manual review` follow-up line.

The original throw still fires when there's a real gap in TMDB's
episode numbering (episode 4 missing from a list of 1, 2, 3, 5) —
that's a data integrity issue, not a cohort issue.

**Known limitation.** When two discs of a season each over-count by
one (D1 cohort=13, D2 cohort=13, season total=25), the cap trims D2
to 12 (correct) but leaves D1 at 13 (which contains one
mis-classified episode). The user gets all 25 episode slots filled
with one mis-label on D1 and one mis-label on D2's extras. A
cross-disc validation pass that compares total claimed episodes
against TMDB's season total is a candidate M11.2 fix.
