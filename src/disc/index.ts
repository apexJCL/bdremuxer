// DiscSource — abstraction over the bytes of a Blu-ray disc.
//
// Spec: specs/spec-iso.md §3.
//
// A DiscSource exposes a path on disk pointing at a `BDMV/index.bdmv`
// directory plus a `close()` to release the underlying resource. The
// pipeline reads exclusively through this interface so adding new
// backends (ISO mount, future formats) doesn't ripple into the stages.
//
// M12 step 1 ships the abstraction + the trivial folder backend. The
// ISO backend lands in step 2 (src/disc/iso-macos.ts).

import { statSync } from "node:fs";
import { resolve } from "node:path";

import { openBdmvDirSource } from "./dir.ts";
import {
  IsoMountError,
  NoBdmvInIsoError,
  UnsupportedDiscInputError,
} from "./errors.ts";
import { cleanupStrandedMounts, openIsoSourceMacOS } from "./iso-macos.ts";

export type DiscSourceKind = "bdmv-dir" | "iso";

export type DiscSource = {
  /** Absolute path to the directory that contains `BDMV/index.bdmv`. */
  readonly bdmvPath: string;

  /**
   * Path the user supplied — directory or .iso file, never the
   * ephemeral mount point. Persisted as `disc.source_path` so resume
   * across runs finds the same disc even when its mount point differs.
   */
  readonly originalPath: string;

  /**
   * Human-readable identifier. For folders: basename. For ISOs:
   * basename minus the `.iso` extension. Used as `disc.volume_label`.
   */
  readonly label: string;

  readonly kind: DiscSourceKind;

  /**
   * Release the source. Idempotent — calling twice is a no-op.
   * For ISO sources, runs `hdiutil detach`. Best-effort: detach
   * failures during `finally` blocks are logged, not thrown.
   */
  close(): Promise<void>;
};

export type DiscSourceContext = {
  /**
   * Directory under which the ISO backend lands its `-mountrandom`
   * mount points. The CLI passes `join(os.tmpdir(), "bdremuxer-mounts")`
   * — per-user, on the boot volume. Landing this under the disc's
   * library directory was the original design but doesn't work when
   * the library lives on a removable volume: macOS's `diskimages-helper`
   * gets EPERM creating new mount points on Thunderbolt / USB drives
   * even when the calling user can write there. Boot-volume-only.
   * Created lazily on first ISO open.
   */
  mountRoot: string;
  /** Logger gate; called only when the user passed `-v` / `-vv`. */
  log: (msg: string) => void;
  /**
   * Optional NDJSON event sink. The CLI wires this to its `emitJson`
   * helper when `--json` is set so the ISO backend can surface
   * `iso_attach_start` / `iso_attached` / `iso_detach` events without
   * importing CLI machinery (specs/spec-iso.md §10). Omit / pass
   * `undefined` to disable.
   */
  emitEvent?: (kind: string, data: Record<string, unknown>) => void;
};

/**
 * Dispatch on the input shape:
 *   - directory → folder backend (bdmv-dir)
 *   - regular file ending in `.iso` (case-insensitive) → ISO backend
 *     (currently macOS-only; other platforms throw with a clear message)
 *   - anything else → UnsupportedDiscInputError
 */
export async function openDiscSource(
  input: string,
  ctx: DiscSourceContext,
): Promise<DiscSource> {
  // Defensive sweep for mounts a previous run left behind under
  // <out>/.bdremuxer/mounts. Idempotent — only the first call per
  // process actually does the work, so calling it from per-disc loops
  // (batch / preflight) is safe (specs/spec-iso.md §11 Q4).
  if (process.platform === "darwin") {
    await cleanupStrandedMounts(ctx.mountRoot, ctx.log);
  }

  const abs = resolve(input);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new UnsupportedDiscInputError(`Path does not exist: ${input}`, input);
  }

  if (st.isDirectory()) {
    return openBdmvDirSource(abs);
  }
  if (st.isFile() && /\.iso$/i.test(abs)) {
    if (process.platform !== "darwin") {
      throw new UnsupportedDiscInputError(
        `ISO ingestion currently requires macOS (uses hdiutil). Mount the disc and point at the BDMV directory.`,
        input,
      );
    }
    return await openIsoSourceMacOS(abs, ctx);
  }
  throw new UnsupportedDiscInputError(
    `Unsupported disc input: ${input}. Pass a directory containing BDMV/index.bdmv, or a .iso file.`,
    input,
  );
}

export { openBdmvDirSource, normalizeBdmvDir, validateBdmvDir } from "./dir.ts";
export { IsoMountError, NoBdmvInIsoError, UnsupportedDiscInputError } from "./errors.ts";

// -----------------------------------------------------------------------
// Open-error classification (used by the preflight aggregator)
// -----------------------------------------------------------------------
//
// When `openDiscSource` throws, callers usually want to:
//   1) record a machine-readable code (for JSON event surfaces),
//   2) include an actionable suggestion in the human-readable message.
// Centralised here so the single-disc, planSingleDisc, and
// executePlannedDisc paths all surface the same hints
// (specs/spec-iso.md §9).

export type DiscOpenErrorClassification = {
  code?: "iso_mount_failed" | "iso_no_bdmv";
  suggestion?: string;
};

export function classifyDiscOpenError(err: unknown): DiscOpenErrorClassification {
  if (err instanceof IsoMountError) {
    return {
      code: "iso_mount_failed",
      suggestion:
        "Check that the file is a valid Blu-ray ISO and not encrypted. " +
        "`hdiutil verify <file>` can confirm the disk image is intact.",
    };
  }
  if (err instanceof NoBdmvInIsoError) {
    return {
      code: "iso_no_bdmv",
      suggestion:
        "The image mounted but doesn't contain BDMV/index.bdmv. " +
        "Confirm this is a Blu-ray ISO (not a DVD or data ISO).",
    };
  }
  return {};
}
