import { describe, expect, test } from "bun:test";
import {
  buildBatchBlocks,
  emptyTemplate,
  groupDiscs,
  serializeBatchToml,
  type WizardAnswers,
} from "../src/init-batch.ts";
import type { DiscDir } from "../src/batch.ts";

const disc = (rel: string): DiscDir => ({ relPath: rel, absPath: `/x/${rel}` });

describe("groupDiscs", () => {
  test("groups discs sharing (show, season)", () => {
    const groups = groupDiscs([
      disc("Breaking Bad - S2 - Disc 1"),
      disc("Breaking Bad - S2 - Disc 2"),
      disc("Breaking Bad - S2 - Disc 3"),
      disc("The Thing"),
    ]);
    expect(groups).toHaveLength(2);
    const tv = groups.find((g) => g.isTvGroup)!;
    expect(tv.members.map((m) => m.relPath)).toEqual([
      "Breaking Bad - S2 - Disc 1",
      "Breaking Bad - S2 - Disc 2",
      "Breaking Bad - S2 - Disc 3",
    ]);
    expect(tv.inferredShowName).toBe("Breaking Bad");
    expect(tv.inferredSeason).toBe(2);

    const movie = groups.find((g) => !g.isTvGroup)!;
    expect(movie.inferredType).toBe("movie");
    expect(movie.members[0]?.relPath).toBe("The Thing");
  });

  test("orders TV groups before singletons", () => {
    const groups = groupDiscs([
      disc("The Thing"),
      disc("Breaking Bad - S2 - Disc 1"),
      disc("Breaking Bad - S2 - Disc 2"),
    ]);
    expect(groups[0]?.isTvGroup).toBe(true);
    expect(groups[1]?.isTvGroup).toBe(false);
  });

  test("solo TV-shaped disc becomes a TV singleton, not a group", () => {
    const groups = groupDiscs([disc("Some Show S1")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.isTvGroup).toBe(false);
    expect(groups[0]?.inferredType).toBe("tv");
    expect(groups[0]?.inferredShowName).toBe("Some Show");
    expect(groups[0]?.inferredSeason).toBe(1);
  });
});

describe("buildBatchBlocks + serializeBatchToml", () => {
  test("emits a group glob plus per-disc starting_episode stubs", () => {
    const answers: WizardAnswers = [
      {
        kind: "tv-group",
        members: [
          disc("Breaking Bad - S2 - Disc 1"),
          disc("Breaking Bad - S2 - Disc 2"),
        ],
        show: "Breaking Bad",
        season: 2,
        tmdbShowId: 1396,
        includeExtras: true,
      },
    ];
    const blocks = buildBatchBlocks(answers);
    expect(blocks).toHaveLength(3); // 1 group + 2 per-disc stubs
    expect(blocks[0]?.glob).toBe("Breaking Bad - S2 - Disc *");
    expect(blocks[0]?.values).toMatchObject({
      type: "tv",
      show: "Breaking Bad",
      season: 2,
      tmdb_show_id: 1396,
      include_extras: true,
    });
    expect(blocks[1]?.glob).toBe("Breaking Bad - S2 - Disc 1");
    expect(blocks[1]?.values.starting_episode).toBe(1);
    expect(blocks[2]?.glob).toBe("Breaking Bad - S2 - Disc 2");

    const toml = serializeBatchToml(blocks);
    expect(toml).toContain(`["Breaking Bad - S2 - Disc *"]`);
    expect(toml).toContain(`type = "tv"`);
    expect(toml).toContain(`season = 2`);
    expect(toml).toContain(`include_extras = true`);
    expect(toml).toContain(`starting_episode = 1`);
  });

  test("singleton movie block", () => {
    const blocks = buildBatchBlocks([
      {
        kind: "singleton",
        member: disc("The Thing"),
        type: "movie",
        title: "The Thing (1982)",
        includeExtras: false,
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.glob).toBe("The Thing");
    expect(blocks[0]?.values).toEqual({
      type: "movie",
      title: "The Thing (1982)",
    });
  });

  test("skipped groups produce no output", () => {
    const blocks = buildBatchBlocks([
      { kind: "skipped", members: [disc("Random Disc")] },
    ]);
    expect(blocks).toHaveLength(0);
  });

  test("serializer escapes embedded quotes in glob keys + values", () => {
    const out = serializeBatchToml([
      {
        glob: 'Title "Foo"/*',
        values: { type: "tv", show: 'A "Quoted" Show' },
      },
    ]);
    expect(out).toContain(`["Title \\"Foo\\"/*"]`);
    expect(out).toContain(`show = "A \\"Quoted\\" Show"`);
  });
});

describe("emptyTemplate", () => {
  test("contains the expected sections + commented example", () => {
    const t = emptyTemplate();
    expect(t).toContain("# bdremuxer batch override file");
    expect(t).toContain("# Resolution order");
    expect(t).toContain(`# ["Breaking Bad - S2*"]`);
    expect(t).toContain(`# starting_episode = 1`);
  });
});
