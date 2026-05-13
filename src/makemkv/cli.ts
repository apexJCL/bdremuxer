// Thin wrapper around `makemkvcon` subprocess invocations.
// M1 only needs `info`; further commands (`mkv`, …) will be added later.

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
