# bdremuxer — ISO ingestion (M12)

Companion to [`spec.md`](./spec.md). This file scopes a single feature:
making `bdremuxer` accept Blu-ray Disc **ISO images** as input, alongside
the existing mounted-BDMV-folder path. The intent is that a library
directory mixed with bare BDMV folders and `.iso` files batches end-to-end
without the user having to mount anything by hand.

The rest of the architecture in `spec.md` is unchanged. `spec.md` §2
currently lists "No ISO/raw-disc ingestion" as a non-goal — this spec
walks that decision back and supersedes that line.

---

## 1. Goals

1. Single-disc: `bdremuxer /path/to/MY_DISC.iso` works the same as
   `bdremuxer /path/to/MY_DISC/` does today.
2. Batch: `bdremuxer batch /path/to/library` discovers `.iso` files in
   the walk alongside BDMV folders and processes them in the same loop,
   with the same override resolution (`bdremuxer.batch.toml` globs and
   per-disc sidecars).
3. Keep the pipeline platform-neutral above the I/O boundary. Once an
   ISO is mounted, every stage (scan, probe, classify, identify, select,
   remux, finalize) sees a regular directory that contains `BDMV/index.bdmv`
   and treats it exactly like a folder-backed disc.
4. macOS-only mount implementation for v1 (`hdiutil`). The abstraction
   is platform-neutral so a Linux (`fuseiso` / `mount -o loop`) or
   Windows (`Mount-DiskImage`) backend can drop in later without
   touching the pipeline.
5. Be safe under interruption. A `Ctrl-C` or crash mid-batch must not
   leave dangling mounts under `/Volumes` (or wherever we land them).

## 2. Non-goals

- Encrypted ISO images (FileVault-encrypted DMGs, AACS-keyed disc images
  that require an external keystore the way `MakeMKVcon` already
  configures one). v1 assumes a plain ISO 9660 / UDF Blu-ray image.
- Other image formats: `.dmg`, `.img`, `.bin/.cue`, `.mds`/`.mdf`. The
  factory dispatches on a `.iso` extension only.
- Modifying `makemkvcon`'s own `iso:` source-URL support. We rely on
  mounting instead — see §11 Q1 for why.
- Mounting BD ISOs that don't contain a `BDMV/index.bdmv` (DVD ISOs,
  data ISOs). These fail the same `validateBdmv` check folder-backed
  discs already fail today.
- Re-running with the ISO unplugged (the file was on removable media
  that's no longer present). Same failure mode as a folder on missing
  media: surface the I/O error from `hdiutil attach`.

## 3. The `DiscSource` abstraction

Today every pipeline stage that needs disc bytes takes a `discRoot:
string` and operates on it directly. ISO support inverts that
slightly: the orchestrator hands each stage an open **DiscSource** that
exposes a path-on-disk pointing at the BDMV folder, plus a `close()` to
release it.

```ts
// src/disc/index.ts

export type DiscSourceKind = "bdmv-dir" | "iso";

export type DiscSource = {
    /**
     * Absolute path to the directory that contains `BDMV/index.bdmv`.
     * For a folder-backed source this is the path the user supplied
     * (or its parent if they pointed at `BDMV/`); for an ISO-backed
     * source this is the mount point hdiutil chose.
     *
     * Every pipeline stage that needs to read disc bytes uses this.
     */
    readonly bdmvPath: string;

    /**
     * The path the user actually supplied — the directory or the .iso
     * file, never the ephemeral mount point. Persisted as
     * `disc.source_path` so resume across runs finds the same disc
     * even when its mount point differs.
     */
    readonly originalPath: string;

    /**
     * Human-readable identifier. For folders: `basename(originalPath)`.
     * For ISOs: `basename(originalPath, ".iso")`. Used as the disc's
     * `volume_label` and as the `relPath` glob-match input in batch
     * mode (relative to the batch root).
     */
    readonly label: string;

    readonly kind: DiscSourceKind;

    /**
     * Release the source. Idempotent — calling twice is a no-op.
     * For ISO sources, this runs `hdiutil detach`. Best-effort: if
     * detach fails (volume busy, already gone), the error is logged
     * but not thrown, since this typically runs in a `finally` block.
     */
    close(): Promise<void>;
};

export async function openDiscSource(
    input: string,
    ctx: DiscSourceContext,
): Promise<DiscSource>;
```

`DiscSourceContext` carries the things the ISO backend needs that the
directory backend doesn't:

```ts
export type DiscSourceContext = {
    /**
     * Directory under which `-mountrandom` lands its mount points.
     * Must be on the boot volume — see §4.1 for why.
     */
    mountRoot: string;
    /** Logger (for hdiutil chatter under `-v` / `-vv`). */
    log: Logger;
};
```

### 3.1 Implementations

- **`src/disc/dir.ts`** — folder backend. `bdmvPath` is the input
  directory (after `normalizeDiscRoot` collapses `…/BDMV` and
  `…/BDMV/index.bdmv` to the disc root). `close()` is a no-op.
- **`src/disc/iso-macos.ts`** — mounts the ISO via `hdiutil`, walks
  the mount point to locate the `BDMV` folder, returns a DiscSource
  whose `close()` runs `hdiutil detach`.

The factory in `src/disc/index.ts` dispatches:

- `input` resolves to a directory → `openBdmvDirSource(input)`.
- `input` resolves to a regular file ending in `.iso` (case-insensitive)
  → `openIsoSourceMacOS(input, ctx)`.
- Anything else → throw a clear error pointing at the supported inputs.

## 4. macOS implementation: `hdiutil`

### 4.1 Attach

```
hdiutil attach \
  -nobrowse \
  -readonly \
  -plist \
  -mountrandom $TMPDIR/bdremuxer-mounts \
  <iso-path>
```

- `-nobrowse` — Finder doesn't surface the mount in the sidebar.
  Keeps the user's UI quiet during a batch with dozens of ISOs.
- `-readonly` — we never write to the disc; mounting RO is faster
  and avoids accidental dirty-unmount issues.
- `-plist` — structured output. The plist's `system-entities` array
  holds the chosen `mount-point`, which we read directly rather than
  scraping stdout.
- `-mountrandom <dir>` — mount under our own working directory rather
  than `/Volumes/<label>`. Wins: no collisions with already-attached
  volumes that share a label, no Finder pollution.

**Why `$TMPDIR/bdremuxer-mounts` and not `<out>/.bdremuxer/mounts`?**
The original design landed mount points under the disc's library
directory, which falls apart for the common case of ISOs on
Thunderbolt / USB drives. macOS's `diskimages-helper` (the privileged
process `hdiutil` delegates the actual mount syscall to) can't create
mount points on removable volumes — even when the calling user can
write there — and errors with `Permission denied`. The user's `$TMPDIR`
(macOS resolves this to `/var/folders/<hash>/T/`, per-user, on the
boot volume) is the safe canonical location.

The `$TMPDIR/bdremuxer-mounts/` directory is created with
`mkdirSync(..., { recursive: true })` on first use.

### 4.2 Locate the BDMV folder

ISOs sometimes nest the BDMV one directory deep (e.g. some authoring
tools wrap with a `<TitleName>/BDMV` layout). After mount we look for
`BDMV/index.bdmv` in this order:

1. `<mount>/BDMV/index.bdmv` (the common case)
2. exactly one direct subdirectory that contains `BDMV/index.bdmv`

If neither matches, detach and throw a clear "no BDMV in <iso-path>"
error. (Multiple BDMV roots in one ISO is rare enough that we don't
guess; surface the error and let the user split.)

### 4.3 Detach

```
hdiutil detach <mount-point>
```

On `-vv` we capture stdout/stderr; otherwise we discard. Exit code is
checked but a non-zero detach during shutdown logs a warning rather
than throwing — the process is leaving anyway, and macOS will reap the
mount within a few seconds of all open file handles closing.

If detach fails because the volume is busy (an open progress log fd
on the mount, etc.) we retry once after a 1 s sleep with
`hdiutil detach -force`. Beyond that, we give up and warn.

### 4.4 The mount registry

Every `openIsoSourceMacOS` call inserts its chosen mount point into
a process-global `Set<string>`. On `SIGINT`, `SIGTERM`, and the
`uncaughtException` paths, a single signal handler walks the set and
fires `hdiutil detach` per entry. Best-effort, in parallel, with a
combined deadline of ~5 s — beyond that, we let the process exit and
rely on the OS to clean up.

Installed once at CLI startup, idempotent. Tests using the abstraction
disable the handler so they don't compete with their own teardown.

## 5. Lifecycle in the pipeline

### 5.1 Single-disc

```ts
const src = await openDiscSource(input, ctx);
try {
    return await runPipelineOnSource(src, opts);
} finally {
    await src.close();
}
```

`runPipelineOnSource` is the current `runPipeline` body refactored to
take a `DiscSource` instead of a string. Stages that previously did
`join(discRoot, "BDMV", "index.bdmv")` now do
`join(src.bdmvPath, "BDMV", "index.bdmv")`; the `makemkvcon` source
URL stays `file:${src.bdmvPath}`.

### 5.2 Batch

The batch loop opens the source per disc, processes, and closes:

```ts
for (const disc of discs) {
    const src = await openDiscSource(disc.absPath, ctx);
    try {
        await runPipelineOnSource(src, perDiscOpts);
    } finally {
        await src.close();
    }
}
```

We deliberately don't keep multiple ISOs mounted at once. For a
50-disc batch with 8 GB ISOs, simultaneous mounts would chew up
kernel resources (and on under-resourced laptops, virtual memory).
Mount-per-disc keeps the working set bounded.

### 5.3 Preflight (M11) interaction

The two-phase plan→rip flow opens each ISO twice — once in phase 1
(scan/probe/identify/select) and once in phase 2 (remux/finalize).
The probe results are cached in SQLite, so phase 2's `makemkvcon info`
call short-circuits, but we still need the mount for the remux's
`makemkvcon mkv` call. Open/close per phase is fine.

If this turns out to be slow for large batches, M12.1 can revisit
keeping mounts open across phases for the **ready** subset. Out of
scope for the initial milestone.

## 6. Walker & path helpers

### 6.1 `walkBdmvFolders`

The walker recognises three terminal cases at each directory:

1. The directory is a disc root (`BDMV/index.bdmv` exists) — record and
   stop descending.
2. The directory contains one or more `*.iso` files — record each as a
   disc, **and** continue descending into subdirectories (an `iso/`
   alongside `unpacked-discs/` should yield both).
3. Otherwise descend.

Each `DiscDir` entry grows a `kind: "bdmv-dir" | "iso"` discriminator,
and `absPath` for an ISO entry is the `.iso` file's absolute path
(not its parent). `relPath` continues to be the path relative to the
batch root and is the glob-match input.

`init-batch` reuses this walker so the wizard sees both flavours.

### 6.2 `normalizeDiscRoot`

Today this trims `…/BDMV` and `…/BDMV/index.bdmv` down to the disc
root. It gains one more case: if the input is a `.iso` file, return it
unchanged. The `validateBdmv` check is replaced by a small
`validateDiscInput` helper that defers to whichever DiscSource backend
the input dispatches to.

## 7. Per-disc sidecar overrides

For folder-backed discs, the override sidecar lives at
`<disc-root>/bdremuxer.toml` (spec §7.1).

For ISO files, we look at two candidates in order:

1. `<dirname(iso)>/<basename(iso, ".iso")>.bdremuxer.toml` — sidecar
   colocated with the ISO, named for it. Example:
   `MY_DISC.iso` + `MY_DISC.bdremuxer.toml`.
2. Fallback only when the ISO sits in its own directory:
   `<dirname(iso)>/bdremuxer.toml` (the same name folder-backed discs
   use). This makes mixed layouts where one ISO sits alone in a
   per-disc folder feel natural.

Either is optional. Glob blocks in `bdremuxer.batch.toml` resolve
against `relPath` exactly as today.

`init-batch` emits ISO-side sidecars in form (1) when it writes
per-disc overrides as part of the wizard.

## 8. Fingerprint

`computeFingerprint` (in `src/pipeline/scan.ts`) hashes
`BDMV/index.bdmv` bytes plus the sorted `(relPath, size)` of every
`*.m2ts` under `BDMV/`. That logic is content-addressed and runs
against the mount point, so the fingerprint of a mounted ISO equals
the fingerprint of the same disc unpacked to a folder. This is the
desired behaviour: a user who unpacks an ISO mid-project resumes
cleanly; a user who packs a folder into an ISO finds their previous
runs already done.

Stored on disc:

- `disc.source_path = src.originalPath` — the ISO path or folder
  path the user typed. Survives across mount-point churn.
- `disc.volume_label = src.label` — `basename` minus `.iso` for
  ISOs; folder basename for folders.

## 9. Errors

| Condition                                    | Behaviour                                                                                                               |
|----------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `hdiutil attach` exits non-zero              | Throw `IsoMountError` with the captured stderr. Batch surfaces this as a `blocked` disc with reason `iso_mount_failed`. |
| Attached but no `BDMV/index.bdmv` found      | Detach, throw `NoBdmvInIsoError`. Single-disc → fail; batch → blocked, reason `iso_no_bdmv`.                            |
| Multiple BDMV roots inside an ISO            | Same as above — surface, don't guess.                                                                                   |
| `hdiutil detach` exits non-zero in `finally` | Log a warning under `-v`, continue. Don't mask the underlying pipeline error.                                           |
| Detach in `SIGINT` handler hangs             | Per-mount deadline 2 s, total deadline 5 s; exit anyway.                                                                |
| `.iso` file is unreadable / disappeared      | `attach` will fail; same as row 1.                                                                                      |
| `.iso` file is a DVD or generic data image   | `BDMV/index.bdmv` will be missing; same as row 2.                                                                       |

`IsoMountError` and `NoBdmvInIsoError` are new exception types under
`src/disc/errors.ts`, sitting alongside the existing
`AmbiguousTvMatchError` / `EpisodeAllocationConflictError`. The
preflight aggregator gains two new blocker codes (`iso_mount_failed`,
`iso_no_bdmv`) and treats them like any other blocker.

## 10. JSON event surface

Under `--json`, two new events fire around ISO mounts so a downstream
viewer can show a "mounting" indicator without polling:

- `iso_attach_start { iso_path }`
- `iso_attached { iso_path, mount_point }`
- `iso_detach { iso_path, mount_point, ok }`

Non-ISO discs emit no new events. Preflight `preflight_blocked` events
gain the two new `reason` codes; otherwise unchanged.

## 11. Open questions

- **Q1 Why not `makemkvcon iso:<path>`?** `makemkvcon` can read an ISO
  directly via the `iso:` source URL, which would skip `hdiutil`
  entirely. We chose mounting instead because:
    1. `scan.computeFingerprint` reads `BDMV/index.bdmv` and lists
       `*.m2ts` sizes from the filesystem. With `iso:` we'd have to
       parse the UDF/ISO 9660 directory tree ourselves (or shell out
       to a tool) to keep the fingerprint stable across ISO ↔ folder.
    2. Several future features (subtitle extraction, NFO export,
       `mkvpropedit` rewrites) will want incidental file access
       (`SUBTITLE/`, `META/DL/`) that's trivial when mounted and
       awkward via `iso:`.
    3. The cost — `hdiutil` calls are ~100 ms each and platform-
       specific — is contained in one file. Saving the mount round
       trip isn't worth losing the rest of the pipeline's filesystem
       assumptions.
       Decided: mount.

- **Q2 Mount location: `/Volumes/` vs `<out>/.bdremuxer/mounts/` vs
  `$TMPDIR/bdremuxer-mounts/`?** Original decision was
  `<out>/.bdremuxer/mounts/` so cleanup is bounded to a directory we
  already own. That broke under the common case of ISOs on Thunderbolt
  / USB drives: macOS's `diskimages-helper` returns `Permission denied`
  when asked to create mount points on a removable volume, even if the
  calling user can write there. Revised: land mount points under
  `$TMPDIR/bdremuxer-mounts/` (per-user, boot-volume-only). Pollutes
  `$TMPDIR` instead, which is what `$TMPDIR` is for. See §4.1.

- **Q3 Open mounts across preflight phases?** Mount-per-disc-per-phase
  for M12. Revisit if profiling shows mount churn matters. Decided:
  re-mount per phase.

- **Q4 Cleanup pass for stranded mounts on startup?** On CLI start,
  list `$TMPDIR/bdremuxer-mounts/*` and attempt `hdiutil detach` on
  each directory still listed by `mount | grep -F`. Defensive against
  a previous run that was `kill -9`'d. Decided: yes, run on every
  `bdremuxer` start (single + batch + init-batch) — fast and benign.

- **Q5 Linux support timing?** Out of scope for v1; `spec.md` §11 is
  still macOS-only. The `DiscSource` factory is structured so that
  adding `iso-linux.ts` is a one-file change behind a `process.platform`
  branch.

## 12. Implementation plan

Reasonable shape for the M12 milestone.

1. **`src/disc/` skeleton.** Introduce `DiscSource`, `DiscSourceKind`,
   `openDiscSource`, the directory backend, and the error types.
   Wire `runPipeline` and the batch loop to acquire/release sources
   in `try/finally`. No ISO support yet — just plumbing. Should be a
   pure refactor with the existing test suite green.

2. **macOS hdiutil backend.** Implement `openIsoSourceMacOS`:
   `hdiutil attach -plist`, plist parsing, BDMV-locator probe,
   `close()` via `hdiutil detach`. Unit-test the plist parser
   against a captured fixture.

3. **Walker + path helpers.** Teach `walkBdmvFolders` and
   `normalizeDiscRoot` about `.iso` files. Add a `kind` field to
   `DiscDir`. Update `validateBdmv` to dispatch.

4. **Sidecar resolution.** Extend `loadSidecarOverrides` to look for
   `<iso-basename>.bdremuxer.toml` before falling back to the
   parent-folder convention.

5. **Mount registry + signal handler.** Process-global set, SIGINT /
   SIGTERM / `uncaughtException` handler that detaches everything.
   Startup cleanup pass for stranded mounts (Q4).

6. **Preflight integration.** Add `iso_mount_failed` and `iso_no_bdmv`
   to the blocker-code union; format them in the issue report.

7. **JSON events.** `iso_attach_start`, `iso_attached`, `iso_detach`.

8. **Tests.**
    - `tests/disc-source.test.ts`: opens a directory-backed source,
      asserts the bdmv path and `close()` is a no-op.
    - `tests/iso-mount.test.ts`: macOS-gated test that mounts a small
      synthetic ISO fixture (we ship one under `tests/fixtures/`),
      asserts the BDMV path resolves, runs `close()`, asserts the
      mount is gone.
    - `tests/walker-iso.test.ts`: walker over a fixture tree with
      mixed folders + ISOs.
    - `tests/sidecar-iso.test.ts`: per-ISO sidecar resolution.

9. **README + spec.md updates.** Remove the ISO non-goal line from
   `specs/spec.md` §2. Add an "ISO files" section to the README's
   quick-start and a row to the layout examples.

## 13. Test fixture: synthetic Blu-ray ISO

To keep `tests/iso-mount.test.ts` self-contained, ship a tiny
`tests/fixtures/blank.iso` (~2 MiB) generated once and checked in:

```
mkdir -p /tmp/iso-stub/BDMV
printf 'fake' > /tmp/iso-stub/BDMV/index.bdmv
dd if=/dev/zero of=/tmp/iso-stub/BDMV/STREAM/00000.m2ts bs=1024 count=1
hdiutil makehybrid -o tests/fixtures/blank.iso -udf -udf-volume-name BDFAKE /tmp/iso-stub
```

The fixture exercises the mount + BDMV-locate path without needing a
real Blu-ray image. `makemkvcon` is **not** invoked against it — that
would require a real disc structure. The probe path is tested
separately with the existing robot-output fixtures, which sit one
layer below `DiscSource`.
