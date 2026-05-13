// Resolve the path to a `makemkvcon` binary.
//
// Order (first hit wins):
//   1. --makemkvcon <path>      (passed in via `override`)
//   2. $MAKEMKVCON
//   3. `makemkvcon` on $PATH    (via Bun.which)
//   4. macOS default install    (/Applications/MakeMKV.app/...)

import { statSync } from "node:fs";

const MACOS_FALLBACK = "/Applications/MakeMKV.app/Contents/MacOS/makemkvcon";

export type DiscoverOpts = { override?: string | undefined };

export function discoverMakemkvcon(opts: DiscoverOpts = {}): string {
  const candidates: (string | null | undefined)[] = [
    opts.override,
    process.env["MAKEMKVCON"],
    Bun.which("makemkvcon"),
    MACOS_FALLBACK,
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (isExecutableFile(c)) return c;
  }

  throw new Error(
    [
      "makemkvcon not found.",
      "Tried (in order): --makemkvcon flag, $MAKEMKVCON, $PATH, " + MACOS_FALLBACK,
      "Install MakeMKV from https://www.makemkv.com/ or point --makemkvcon at the binary.",
    ].join("\n"),
  );
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // mode bit 0o111 = any execute bit set
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
