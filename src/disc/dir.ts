// Folder-backed DiscSource (specs/spec-iso.md §3.1).
//
// Input: a directory containing BDMV/index.bdmv (or BDMV/, or index.bdmv
// itself — we collapse to the disc root). bdmvPath === originalPath.
// close() is a no-op; there's nothing to release.

import { basename, resolve } from "node:path";
import { statSync } from "node:fs";

import type { DiscSource } from "./index.ts";

/** Collapse an input pointing at BDMV/ or BDMV/index.bdmv to the disc root. */
export function normalizeBdmvDir(input: string): string {
  const abs = resolve(input);
  const base = basename(abs);
  if (base === "index.bdmv") return resolve(abs, "..", "..");
  if (base === "BDMV") return resolve(abs, "..");
  return abs;
}

/** Validate that a directory looks like a Blu-ray disc root. */
export function validateBdmvDir(
  discRoot: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const st = statSync(discRoot);
    if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${discRoot}` };
  } catch {
    return { ok: false, error: `Path does not exist: ${discRoot}` };
  }
  try {
    const indexPath = `${discRoot}/BDMV/index.bdmv`;
    const st = statSync(indexPath);
    if (!st.isFile()) return { ok: false, error: `${indexPath} is not a file` };
  } catch {
    return {
      ok: false,
      error: `No BDMV/index.bdmv under ${discRoot}. Point at the directory that contains the BDMV folder.`,
    };
  }
  return { ok: true };
}

export function openBdmvDirSource(input: string): DiscSource {
  const discRoot = normalizeBdmvDir(input);
  const validation = validateBdmvDir(discRoot);
  if (!validation.ok) throw new Error(validation.error);
  return {
    kind: "bdmv-dir",
    bdmvPath: discRoot,
    originalPath: discRoot,
    label: basename(discRoot),
    async close() {},
  };
}
