#!/usr/bin/env bun
//
// M1 walking skeleton:
//   bdremuxer <BDMV path> [--makemkvcon PATH] [-v|--verbose] [-h|--help]
//
// Validates the path, finds `makemkvcon`, runs `makemkvcon info`, and prints
// a human-readable summary of the disc + its titles + streams.
//
// No DB, no API calls, no remuxing — those land in M2+.

import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { join, basename, resolve } from "node:path";

import { discoverMakemkvcon } from "./makemkv/discover.ts";
import { runInfo } from "./makemkv/cli.ts";
import type { ProbeResult, TitleInfo } from "./makemkv/robot.ts";
import { CINFO, SINFO, TINFO } from "./makemkv/codes.ts";

const HELP = `bdremuxer (M1)

Usage:
  bdremuxer <BDMV path> [options]

Options:
  --makemkvcon <path>   override makemkvcon binary location
  -v, --verbose         print extra info including raw MakeMKV messages
  -h, --help            show this help

In this milestone the tool only probes the disc and prints what it found.
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        makemkvcon: { type: "string" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`Expected exactly one BDMV path argument.\n\n${HELP}`);
    return 2;
  }

  const discRoot = normalizeDiscRoot(positionals[0]!);
  const validation = validateBdmv(discRoot);
  if (!validation.ok) {
    process.stderr.write(`${validation.error}\n`);
    return 1;
  }

  let makemkvcon: string;
  try {
    makemkvcon = discoverMakemkvcon({ override: values.makemkvcon });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  if (values.verbose) {
    process.stderr.write(`[bdremuxer] makemkvcon: ${makemkvcon}\n`);
    process.stderr.write(`[bdremuxer] disc root: ${discRoot}\n`);
    process.stderr.write(`[bdremuxer] running info (this can take a while)...\n`);
  }

  try {
    const { probe } = await runInfo({
      makemkvcon,
      source: `file:${discRoot}`,
      echoStderr: values.verbose,
    });
    printSummary(probe, { verbose: !!values.verbose });
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}

// `BDMV` and `BDMV/index.bdmv` are both common ways for a user to refer to a
// disc; normalize to the disc root (the directory that *contains* BDMV).
function normalizeDiscRoot(input: string): string {
  const abs = resolve(input);
  const base = basename(abs);
  if (base === "index.bdmv") return resolve(abs, "..", "..");
  if (base === "BDMV") return resolve(abs, "..");
  return abs;
}

function validateBdmv(discRoot: string): { ok: true } | { ok: false; error: string } {
  try {
    const st = statSync(discRoot);
    if (!st.isDirectory()) {
      return { ok: false, error: `Not a directory: ${discRoot}` };
    }
  } catch {
    return { ok: false, error: `Path does not exist: ${discRoot}` };
  }
  try {
    const st = statSync(join(discRoot, "BDMV", "index.bdmv"));
    if (!st.isFile()) {
      return { ok: false, error: `${discRoot}/BDMV/index.bdmv is not a file` };
    }
  } catch {
    return {
      ok: false,
      error: `No BDMV/index.bdmv under ${discRoot}. Point at the directory that contains the BDMV folder.`,
    };
  }
  return { ok: true };
}

function printSummary(probe: ProbeResult, opts: { verbose: boolean }): void {
  const w = (s: string) => process.stdout.write(s);
  const name = probe.disc.get(CINFO.NAME) ?? probe.disc.get(CINFO.VOLUME_NAME) ?? "(unknown)";
  const type = probe.disc.get(CINFO.TYPE) ?? "?";

  w(`Disc: ${name}  [${type}]\n`);
  w(`Titles reported: ${probe.titleCount}\n`);
  w("\n");

  const titleIdxs = [...probe.titles.keys()].sort((a, b) => a - b);
  for (const idx of titleIdxs) {
    const t = probe.titles.get(idx)!;
    printTitle(t);
  }

  if (opts.verbose && probe.messages.length > 0) {
    w("\n-- MakeMKV messages --\n");
    for (const m of probe.messages) w(`  ${m}\n`);
  }
}

function printTitle(t: TitleInfo): void {
  const w = (s: string) => process.stdout.write(s);

  const dur = t.info.get(TINFO.DURATION) ?? "?";
  const size = t.info.get(TINFO.SIZE_HUMAN) ?? "?";
  const segs = t.info.get(TINFO.SEGMENT_MAP) ?? "?";
  const out = t.info.get(TINFO.OUTPUT_FILENAME) ?? "?";
  const chapters = t.info.get(TINFO.CHAPTER_COUNT) ?? "?";

  w(
    `[#${t.index.toString().padStart(2, "0")}] ` +
      `${dur}  ${size}  chapters=${chapters}  out=${out}\n`,
  );
  w(`        segments: ${segs}\n`);

  const streamIdxs = [...t.streams.keys()].sort((a, b) => a - b);
  for (const sIdx of streamIdxs) {
    const s = t.streams.get(sIdx)!;
    const kind = s.get(SINFO.TYPE) ?? "?";
    const lang = s.get(SINFO.LANG_CODE) ?? "---";
    const codec = s.get(SINFO.CODEC_LONG) ?? s.get(SINFO.CODEC_SHORT) ?? "?";
    const extra = describeStreamExtras(kind, s);
    w(`        ${kind.padEnd(9)} ${lang.padEnd(4)} ${codec}${extra}\n`);
  }
  w("\n");
}

function describeStreamExtras(kind: string, s: Map<number, string>): string {
  const parts: string[] = [];
  if (kind.toLowerCase() === "video") {
    const size = s.get(SINFO.VIDEO_SIZE);
    if (size) parts.push(size);
  } else if (kind.toLowerCase() === "audio") {
    const ch = s.get(SINFO.CHANNELS);
    if (ch) parts.push(`${ch}ch`);
    const desc = s.get(SINFO.DESCRIPTION);
    if (desc) parts.push(desc);
  }
  const flags = s.get(SINFO.MKV_FLAGS_TEXT);
  if (flags) parts.push(`[${flags}]`);
  return parts.length ? `  ${parts.join("  ")}` : "";
}

const exit = await main(Bun.argv.slice(2));
process.exit(exit);
