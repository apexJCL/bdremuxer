// Thin wrapper around `makemkvcon` subprocess invocations.
//
//   runInfo  → `makemkvcon info`  (buffers stdout — output is small/fast)
//   runMkv   → `makemkvcon mkv`   (streams stdout — rips run for minutes)

import { appendFileSync, openSync, writeSync, closeSync } from "node:fs";

import { parseRobotOutput, type ProbeResult } from "./robot.ts";

export type InfoOpts = {
  makemkvcon: string;
  source: string;       // e.g. "file:/Volumes/THE_THING"
  cache?: number;       // MakeMKV's --cache=N (MiB). Default 1 keeps memory tiny.
  echoStderr?: boolean; // pipe makemkvcon stderr straight through for debugging
};

export type InfoResult = {
  probe: ProbeResult;
  rawStdout: string;
  exitCode: number;
};

export async function runInfo(opts: InfoOpts): Promise<InfoResult> {
  const cache = opts.cache ?? 1;
  const args = [opts.makemkvcon, "-r", `--cache=${cache}`, "info", opts.source];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: opts.echoStderr ? "inherit" : "pipe",
    env: process.env,
  });

  const rawStdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const tail = rawStdout
      .split("\n")
      .filter((l) => l.startsWith("MSG:"))
      .slice(-3)
      .join("\n");
    throw new Error(
      `makemkvcon exited with code ${exitCode}.\nLast MSG lines:\n${tail || "(none)"}`,
    );
  }

  return { probe: parseRobotOutput(rawStdout), rawStdout, exitCode };
}

export type MkvOpts = {
  makemkvcon: string;
  source: string;        // e.g. "file:/Volumes/THE_THING"
  titleId: number;
  outputDir: string;
  logPath: string;       // raw stdout is tee'd here
  cache?: number;
  onProgress?: (frac: number, currentTask?: string) => void;
};

export type MkvResult = {
  exitCode: number;
  tailMessages: string[];
};

// Run `makemkvcon mkv` for a single title. Streams output line-by-line so
// the caller can render progress while the rip is in flight, and tees raw
// stdout to `logPath` for post-mortem.
export async function runMkv(opts: MkvOpts): Promise<MkvResult> {
  const cache = opts.cache ?? 1;
  const args = [
    opts.makemkvcon,
    "-r",
    `--cache=${cache}`,
    "--progress=-stdout",
    "mkv",
    opts.source,
    String(opts.titleId),
    opts.outputDir,
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: process.env });

  const logFd = openSync(opts.logPath, "w");
  const recentMsgs: string[] = [];

  try {
    let buf = "";
    let currentTask = "";
    const decoder = new TextDecoder();
    // Bun.spawn returns a ReadableStream<Uint8Array> on stdout.
    for await (const chunk of proc.stdout) {
      writeSync(logFd, chunk);
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    if (buf) handleLine(buf);

    function handleLine(line: string): void {
      if (line.startsWith("PRGV:")) {
        if (!opts.onProgress) return;
        const parts = line.slice(5).split(",");
        const current = Number(parts[0]);
        const max = Number(parts[2]);
        if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
          opts.onProgress(Math.min(1, current / max), currentTask);
        }
      } else if (line.startsWith("PRGT:") || line.startsWith("PRGC:")) {
        const m = line.match(/^PRG[TC]:\d+,\d+,"(.+)"$/);
        if (m) currentTask = m[1]!;
      } else if (line.startsWith("MSG:")) {
        recentMsgs.push(line);
        if (recentMsgs.length > 10) recentMsgs.shift();
      }
    }

    // Drain stderr into the same log (separate concern from progress).
    if (proc.stderr) {
      const stderrText = await new Response(proc.stderr).text();
      if (stderrText) appendFileSync(opts.logPath, `\n--- stderr ---\n${stderrText}`);
    }
  } finally {
    closeSync(logFd);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const tail = recentMsgs.slice(-3).join("\n");
    throw new Error(
      `makemkvcon mkv exited with code ${exitCode}.\nLast MSG lines:\n${tail || "(none)"}\nFull log: ${opts.logPath}`,
    );
  }
  return { exitCode, tailMessages: recentMsgs };
}
