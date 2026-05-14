#!/usr/bin/env bun
//
// One-shot release helper. Bumps package.json's version, commits, tags,
// and pushes — which triggers the release.yml workflow on GitHub to
// build + publish the macOS arm64 standalone binary.
//
// Usage:
//   bun run publish                  # patch bump (0.0.1 → 0.0.2)
//   bun run publish minor            # 0.0.1 → 0.1.0
//   bun run publish major            # 0.0.1 → 1.0.0
//   bun run publish 1.2.3            # set exactly
//   bun run publish --dry-run        # print every step, don't execute
//   bun run publish --yes            # skip the confirmation prompt
//   bun run publish --branch=dev     # release from a non-main branch
//   bun run publish --remote=upstream
//
// Safety:
//   - Refuses to run with uncommitted changes (catch them before bumping).
//   - Refuses to run from a non-main branch unless --branch is set.
//   - Runs `bun run typecheck` and `bun test` BEFORE the version bump,
//     so a CI-breaking change is caught before any state is mutated.

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Prompter } from "../src/parse/prompt.ts";

const PKG_JSON = join(process.cwd(), "package.json");

main().catch((e: unknown) => {
  process.stderr.write(`\nError: ${(e as Error).message}\n`);
  process.exit(1);
});

// -----------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      remote: { type: "string" },
      branch: { type: "string" },
    },
    allowPositionals: true,
  });

  const bump = positionals[0] ?? "patch";
  validateBump(bump);

  const remote = values.remote ?? "origin";
  const branch = values.branch ?? "main";
  const dryRun = !!values["dry-run"];
  const autoYes = !!values.yes;

  await ensureClean();
  await ensureOnBranch(branch);

  const current = readVersion();
  const next = computeNextVersion(current, bump);
  const tag = `v${next}`;

  process.stdout.write(`\n  bdremuxer release\n`);
  process.stdout.write(`  ─────────────────\n`);
  process.stdout.write(`  bump:    ${current} → ${next}\n`);
  process.stdout.write(`  tag:     ${tag}\n`);
  process.stdout.write(`  push to: ${remote} ${branch} --follow-tags\n`);
  if (dryRun) process.stdout.write(`  mode:    dry-run (no side effects)\n`);
  process.stdout.write(`\n`);

  if (!autoYes && !dryRun) {
    const prompter = new Prompter();
    try {
      const ok = await prompter.askBool("Proceed?", false);
      if (!ok) {
        process.stderr.write("Aborted.\n");
        process.exit(1);
      }
    } finally {
      prompter.close();
    }
  }

  // Pre-flight (still on the old version — failure here doesn't leave a
  // dirty package.json behind).
  await step("bun run typecheck", () => run("bun", ["run", "typecheck"], dryRun));
  await step("bun test", () => run("bun", ["test"], dryRun));

  // From here on, failures may leave a half-finished state. We surface
  // hints to make recovery obvious.
  await step(`update package.json (version=${next})`, () => {
    if (!dryRun) writeVersion(next);
  });
  try {
    await step("git add package.json", () =>
      run("git", ["add", "package.json"], dryRun));
    await step(`git commit -m "Release ${tag}"`, () =>
      run("git", ["commit", "-m", `Release ${tag}`], dryRun));
    await step(`git tag ${tag}`, () => run("git", ["tag", tag], dryRun));
    await step(`git push ${remote} ${branch} --follow-tags`, () =>
      run("git", ["push", remote, branch, "--follow-tags"], dryRun));
  } catch (e) {
    process.stderr.write(
      `\nPost-bump step failed. Recovery hints:\n` +
        `  - If commit/tag/push failed, inspect with \`git status\` + \`git log -1\`.\n` +
        `  - To roll back the version bump: \`git checkout -- package.json\`\n` +
        `    (only if it wasn't committed) OR \`git reset --hard HEAD~1\`\n` +
        `    if the commit landed but the push failed.\n` +
        `  - To remove a tag that was created but not pushed:\n` +
        `    \`git tag -d ${tag}\`\n`,
    );
    throw e;
  }

  process.stdout.write(
    `\n✓ ${dryRun ? "Dry-run complete" : `Released ${tag}`}.\n` +
      (dryRun
        ? ""
        : `   The release workflow should now be running on GitHub.\n`),
  );
}

// -----------------------------------------------------------------------
// Version handling
// -----------------------------------------------------------------------

function validateBump(bump: string): void {
  if (bump === "patch" || bump === "minor" || bump === "major") return;
  if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(bump)) return;
  throw new Error(
    `Bump must be patch | minor | major | <x.y.z>  (got "${bump}").`,
  );
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`No "version" field in package.json`);
  return pkg.version;
}

// Preserve package.json's existing formatting / trailing newline by patching
// the version line in-place rather than round-tripping through JSON.parse +
// JSON.stringify (which would normalize indentation and lose key order).
function writeVersion(version: string): void {
  const text = readFileSync(PKG_JSON, "utf8");
  const updated = text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`);
  if (updated === text) {
    throw new Error(`Couldn't locate "version": "..." line in package.json`);
  }
  writeFileSync(PKG_JSON, updated);
}

function computeNextVersion(current: string, bump: string): string {
  if (bump === "patch" || bump === "minor" || bump === "major") {
    const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/);
    if (!m) throw new Error(`Current version "${current}" isn't semver-shaped`);
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);
    if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
    if (bump === "minor") return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }
  return bump.replace(/^v/, "");
}

// -----------------------------------------------------------------------
// Git checks
// -----------------------------------------------------------------------

async function ensureClean(): Promise<void> {
  const out = await capture("git", ["status", "--porcelain"]);
  if (out.trim() !== "") {
    throw new Error(
      `Working tree has uncommitted changes:\n${out.trimEnd()}\n\n` +
        `Commit or stash before publishing — the release script needs a clean slate.`,
    );
  }
}

async function ensureOnBranch(branch: string): Promise<void> {
  const head = (await capture("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head !== branch) {
    throw new Error(
      `Currently on branch "${head}", expected "${branch}". ` +
        `Switch with \`git checkout ${branch}\` or override with --branch=${head}.`,
    );
  }
}

// -----------------------------------------------------------------------
// Subprocess helpers
// -----------------------------------------------------------------------

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`→ ${label}\n`);
  await fn();
}

async function run(cmd: string, args: string[], dryRun: boolean): Promise<void> {
  if (dryRun) {
    process.stdout.write(`    [dry-run] ${cmd} ${args.join(" ")}\n`);
    return;
  }
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${code}`);
  }
}

async function capture(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited with code ${code}: ${err.trim()}`,
    );
  }
  return out;
}
