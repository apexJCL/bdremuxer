// macOS ISO backend (specs/spec-iso.md §4).
//
//   openIsoSourceMacOS(iso, ctx)
//     → hdiutil attach (-nobrowse, -readonly, -mountrandom <ctx.mountRoot>)
//     → parse the returned plist for the mount point
//     → locate BDMV/index.bdmv inside the mount (root or one dir deep)
//     → return a DiscSource whose close() runs hdiutil detach
//
// A process-global mount registry + signal handler runs detach on
// SIGINT / SIGTERM / uncaughtException so a `Ctrl-C` mid-batch doesn't
// strand mounts under <out>/.bdremuxer/mounts/.

import { mkdirSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { IsoMountError, NoBdmvInIsoError } from "./errors.ts";
import type { DiscSource, DiscSourceContext } from "./index.ts";

// -----------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------

export async function openIsoSourceMacOS(
  isoPath: string,
  ctx: DiscSourceContext,
): Promise<DiscSource> {
  installSignalHandlers();
  const emit = ctx.emitEvent;

  mkdirSync(ctx.mountRoot, { recursive: true });
  ctx.log(`iso: attaching ${isoPath} (mountRoot=${ctx.mountRoot})`);
  emit?.("iso_attach_start", { iso_path: isoPath });

  const attached = await hdiutilAttach(isoPath, ctx.mountRoot);
  liveMounts.set(attached.mountPoint, isoPath);
  ctx.log(`iso: attached ${attached.mountPoint} (dev ${attached.devEntry || "?"})`);
  emit?.("iso_attached", { iso_path: isoPath, mount_point: attached.mountPoint });

  let bdmvPath: string;
  try {
    bdmvPath = locateBdmv(attached.mountPoint, isoPath);
  } catch (e) {
    // Detach best-effort, then rethrow the locator error so the caller
    // surfaces the actual problem (no BDMV / multiple BDMV / unreadable).
    await emitDetach(emit, isoPath, attached.mountPoint, ctx.log);
    throw e;
  }

  const label = basename(isoPath, ".iso");
  let closed = false;
  return {
    kind: "iso",
    bdmvPath,
    originalPath: isoPath,
    label,
    async close() {
      if (closed) return;
      closed = true;
      await emitDetach(emit, isoPath, attached.mountPoint, ctx.log);
    },
  };
}

async function emitDetach(
  emit: ((kind: string, data: Record<string, unknown>) => void) | undefined,
  isoPath: string,
  mountPoint: string,
  log: (msg: string) => void,
): Promise<void> {
  const ok = await detachAndReport(mountPoint, log);
  liveMounts.delete(mountPoint);
  log(`iso: detached ${mountPoint}${ok ? "" : " (with errors)"}`);
  emit?.("iso_detach", { iso_path: isoPath, mount_point: mountPoint, ok });
}

async function detachAndReport(
  mountPoint: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const first = await hdiutilDetach(mountPoint);
  if (first.ok) return true;
  log(
    `iso: detach ${mountPoint} failed (${first.stderr.trim() || "no stderr"}); retrying with -force after 1s`,
  );
  await new Promise((r) => setTimeout(r, 1000));
  const second = await hdiutilDetach(mountPoint, { force: true });
  if (second.ok) return true;
  log(
    `iso: detach -force ${mountPoint} still failing (${second.stderr.trim() || "no stderr"}) — giving up`,
  );
  return false;
}

// -----------------------------------------------------------------------
// hdiutil wrappers
// -----------------------------------------------------------------------

export type AttachResult = {
  mountPoint: string;
  devEntry: string;
};

async function hdiutilAttach(isoPath: string, mountRoot: string): Promise<AttachResult> {
  const proc = Bun.spawn(
    [
      "hdiutil",
      "attach",
      "-nobrowse",
      "-readonly",
      "-plist",
      "-mountrandom",
      mountRoot,
      isoPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const tail = (stderr.trim() || stdout.trim() || "(no stderr)").slice(0, 500);
    throw new IsoMountError(
      `hdiutil attach exited with code ${code}: ${tail}`,
      isoPath,
    );
  }
  const parsed = parseAttachPlist(stdout);
  if (!parsed) {
    throw new IsoMountError(
      `hdiutil attach didn't return a mount point. Plist:\n${stdout.slice(0, 1000)}`,
      isoPath,
    );
  }
  return parsed;
}

/**
 * Extract the first system-entity that carries a `<mount-point>` from
 * hdiutil's attach plist. hdiutil emits one <dict> per system-entity
 * (the whole disk, each partition, etc.); BD ISOs typically have one
 * mountable entity. Regex over the XML is fine here — hdiutil's output
 * is deterministic and key order within each <dict> doesn't matter for
 * us because we match `<key>X</key>\s*<string>Y</string>` pairs.
 *
 * Exported for unit tests.
 */
export function parseAttachPlist(plistXml: string): AttachResult | null {
  const dictRegex = /<dict>([\s\S]*?)<\/dict>/g;
  let m: RegExpExecArray | null;
  while ((m = dictRegex.exec(plistXml)) !== null) {
    const body = m[1] ?? "";
    const mp = body.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
    if (!mp) continue;
    const dev = body.match(/<key>dev-entry<\/key>\s*<string>([^<]+)<\/string>/);
    return { mountPoint: mp[1]!, devEntry: dev?.[1] ?? "" };
  }
  return null;
}

async function hdiutilDetach(
  mountPoint: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; stderr: string }> {
  const args = ["hdiutil", "detach"];
  if (opts.force) args.push("-force");
  args.push(mountPoint);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stderr };
}

// -----------------------------------------------------------------------
// Stranded-mount cleanup (specs/spec-iso.md §11 Q4)
// -----------------------------------------------------------------------
//
// On CLI start, sweep `<out>/.bdremuxer/mounts/*`. Two kinds of leftovers
// can show up after a previous run was killed:
//
//   - a subdir that is still in the live mount table → `hdiutil detach
//     -force`, then rmdir.
//   - a subdir that is no longer mounted → bare rmdir to keep the tree
//     tidy. (hdiutil detach also removes its own mount dir, but a
//     half-finished run can leave one behind.)
//
// Idempotent: a process-global flag short-circuits subsequent calls so
// invoking this inside per-disc loops (e.g. batch + init-batch sharing
// `openDiscSource`) doesn't try to detach mounts the current run just
// created. mountRoot is captured on the first call.

let strandedCleanupDone = false;

export async function cleanupStrandedMounts(
  mountRoot: string,
  log: (msg: string) => void,
): Promise<void> {
  if (strandedCleanupDone) return;
  strandedCleanupDone = true;

  let entries;
  try {
    entries = readdirSync(mountRoot, { withFileTypes: true });
  } catch {
    return; // mount root doesn't exist yet — nothing to do
  }
  if (entries.length === 0) return;

  const mounted = await listMountedPaths();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const candidate = join(mountRoot, ent.name);
    if (mounted.has(candidate)) {
      log(`iso: stranded mount detected — detaching ${candidate}`);
      const res = await hdiutilDetach(candidate, { force: true });
      if (!res.ok) {
        log(`iso: detach failed for ${candidate}: ${res.stderr.trim() || "no stderr"}`);
        continue; // leave the dir; hdiutil owns it
      }
    }
    // Either the dir was never mounted, or we just detached. Either way
    // a bare rmdir is appropriate to tidy up.
    try {
      rmdirSync(candidate);
    } catch {
      // Non-empty / busy / vanished — leave it.
    }
  }
}

async function listMountedPaths(): Promise<Set<string>> {
  const proc = Bun.spawn(["mount"], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const set = new Set<string>();
  // BSD `mount` output: `/dev/disk2s1 on /tmp/foo/dsk1 (msdos, local, …)`.
  // The mount point follows " on " and ends before " (".
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\S+ on (.+?) \(/);
    if (m) set.add(m[1]!);
  }
  return set;
}

// -----------------------------------------------------------------------
// BDMV locator
// -----------------------------------------------------------------------

// Search for BDMV/index.bdmv at the mount root and up to MAX_DEPTH
// directories deep. Stops descending into any branch the moment it
// finds a BDMV root (discs don't nest). Bounded so a pathological ISO
// can't make us walk the entire tree.
const MAX_BDMV_DEPTH = 2;

function locateBdmv(mountPoint: string, isoPath: string): string {
  const found = findBdmvRoots(mountPoint, MAX_BDMV_DEPTH);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new NoBdmvInIsoError(
      `Multiple BDMV roots inside ${isoPath}: ${found
        .map((c) => relativePath(mountPoint, c))
        .join(", ")}. Split the ISO and point at each disc.`,
      isoPath,
    );
  }

  // Diagnostic message: include what's actually at the mount root so
  // the user can tell at a glance whether this is a non-Blu-ray ISO
  // (DVD, data) or a Blu-ray with a wrapper deeper than we search.
  let topLevel: string;
  try {
    const entries = readdirSync(mountPoint)
      .filter((n) => !n.startsWith("."))
      .slice(0, 12);
    topLevel = entries.length > 0 ? entries.join(", ") : "(empty)";
  } catch (e) {
    topLevel = `(unreadable: ${(e as Error).message})`;
  }
  throw new NoBdmvInIsoError(
    `No BDMV/index.bdmv inside ${isoPath} ` +
      `(searched mount ${mountPoint} to depth ${MAX_BDMV_DEPTH}). ` +
      `Top-level contents: ${topLevel}. Is this a Blu-ray ISO?`,
    isoPath,
  );
}

function findBdmvRoots(start: string, maxDepth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (hasBdmv(dir)) {
      found.push(dir);
      return; // discs don't nest
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".")) continue;
      walk(join(dir, ent.name), depth + 1);
    }
  };
  walk(start, 0);
  return found;
}

function hasBdmv(dir: string): boolean {
  try {
    return statSync(join(dir, "BDMV", "index.bdmv")).isFile();
  } catch {
    return false;
  }
}

function relativePath(root: string, abs: string): string {
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
}

// -----------------------------------------------------------------------
// Mount registry + signal handlers
// -----------------------------------------------------------------------

/** mountPoint → isoPath. Module-global; one entry per live mount. */
const liveMounts = new Map<string, string>();

let signalsInstalled = false;

function installSignalHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  process.on("SIGINT", () => {
    detachAllSync();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    detachAllSync();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    detachAllSync();
    // Re-throw via stderr + nonzero exit; can't recover here.
    process.stderr.write(`[bdremuxer] uncaught: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}

/**
 * Synchronous detach for use inside signal handlers — the event loop
 * may be stopping, so we can't await. Best-effort: errors are swallowed
 * and `-force` is always used since this only fires on shutdown.
 */
function detachAllSync(): void {
  for (const mp of liveMounts.keys()) {
    try {
      Bun.spawnSync(["hdiutil", "detach", "-force", mp]);
    } catch {}
  }
  liveMounts.clear();
}

// -----------------------------------------------------------------------
// Test hooks
// -----------------------------------------------------------------------

/** Test-only: drain the registry without firing detach. */
export function _resetRegistryForTests(): void {
  liveMounts.clear();
}

/** Test-only: re-arm the stranded-cleanup guard so a fresh call will run. */
export function _resetStrandedCleanupForTests(): void {
  strandedCleanupDone = false;
}
