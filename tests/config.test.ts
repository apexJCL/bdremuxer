import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.ts";

// Save + restore env vars so cases don't bleed across tests.
const SNAPSHOT_KEYS = [
  "BDREMUXER_OUTPUT_DIR",
  "BDREMUXER_DB_PATH",
  "BDREMUXER_TMDB_API_KEY",
  "BDREMUXER_OMDB_API_KEY",
] as const;

function snapshot(): Map<string, string | undefined> {
  return new Map(SNAPSHOT_KEYS.map((k) => [k, process.env[k]]));
}
function restore(s: Map<string, string | undefined>): void {
  for (const [k, v] of s) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("loadConfig outDir resolution", () => {
  const snap = snapshot();
  afterEach(() => restore(snap));

  test("explicit override wins over everything", () => {
    process.env.BDREMUXER_OUTPUT_DIR = "/from-env";
    const cfg = loadConfig({
      outDir: "/from-flag",
      defaultOutDir: "/from-default",
    });
    expect(cfg.outDir).toBe(resolve("/from-flag"));
  });

  test("env var wins over defaultOutDir", () => {
    process.env.BDREMUXER_OUTPUT_DIR = "/from-env";
    const cfg = loadConfig({ defaultOutDir: "/from-default" });
    expect(cfg.outDir).toBe(resolve("/from-env"));
  });

  test("defaultOutDir kicks in when nothing else is set", () => {
    delete process.env.BDREMUXER_OUTPUT_DIR;
    const cfg = loadConfig({ defaultOutDir: "/volumes/the-thing-parent" });
    expect(cfg.outDir).toBe(resolve("/volumes/the-thing-parent"));
  });

  test("falls back to ./out when no context at all", () => {
    delete process.env.BDREMUXER_OUTPUT_DIR;
    const cfg = loadConfig();
    expect(cfg.outDir).toBe(resolve("./out"));
  });

  test("dbPath defaults under the resolved outDir", () => {
    delete process.env.BDREMUXER_OUTPUT_DIR;
    delete process.env.BDREMUXER_DB_PATH;
    const cfg = loadConfig({ defaultOutDir: "/library" });
    expect(cfg.dbPath).toBe(resolve("/library/.bdremuxer.sqlite"));
  });
});
