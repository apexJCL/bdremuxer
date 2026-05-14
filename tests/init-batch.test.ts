import { describe, expect, test } from "bun:test";
import {
  boxsetAnswers,
  buildBatchBlocks,
  emptyTemplate,
  groupDiscs,
  movieDiscsAnswers,
  serializeBatchToml,
  type TvGroupAnswer,
  type SingletonAnswer,
  type WizardAnswers,
} from "../src/init-batch.ts";
import type { DiscDir } from "../src/batch.ts";
import { globMatch } from "../src/parse/glob.ts";

const disc = (rel: string): DiscDir => ({
  relPath: rel,
  absPath: `/x/${rel}`,
  kind: "bdmv-dir",
});

const iso = (rel: string): DiscDir => ({
  relPath: rel,
  absPath: `/x/${rel}`,
  kind: "iso",
});

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
    // Per-disc blocks should name the group + position so the file is
    // self-documenting on re-read.
    expect(toml).toContain(`# Disc 1 of 2 in "Breaking Bad - S2".`);
    expect(toml).toContain(`# Disc 2 of 2 in "Breaking Bad - S2".`);
  });

  test("ISO-backed TV group uses ** so the glob matches relPaths with the .iso filename below the disc dir", () => {
    // Regression: with single `*` (no slash crossing) the group-level
    // block fails to match ISO disc relPaths like "S4 D1/Show.Name.S04D01.iso",
    // so tmdb_show_id never reaches the disc and identify falls back to
    // search. Switching to `**` keeps the block applicable.
    const group: TvGroupAnswer = {
      kind: "tv-group",
      members: [
        iso("S4 D1/Show.Name.S04D01.iso"),
        iso("S4 D2/Show.Name.S04D02.iso"),
        iso("S4 D3/Show.Name.S04D03.iso"),
      ],
      show: "Show Name (2020)",
      season: 4,
      tmdbShowId: 12345,
      includeExtras: false,
    };
    const blocks = buildBatchBlocks([group]);
    expect(blocks[0]?.glob).toBe("S4 D**");
    // The whole point: every member's relPath actually matches the glob.
    for (const m of group.members) {
      expect(globMatch(blocks[0]!.glob, m.relPath)).toBe(true);
    }
  });

  test("folder-backed TV group stays on * (no over-matching siblings)", () => {
    // Belt-and-braces: the ISO branch is an *upgrade* to `**`; pure
    // folder-backed groups must keep the narrower single-* form.
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
        includeExtras: false,
      },
    ];
    const blocks = buildBatchBlocks(answers);
    expect(blocks[0]?.glob).toBe("Breaking Bad - S2 - Disc *");
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

describe("boxsetAnswers (whole directory is one TV show)", () => {
  test("buckets discs by parsed season, carrying shared show/tmdb_show_id", () => {
    const answers = boxsetAnswers(
      [
        disc("Breaking Bad - S2 - Disc 1"),
        disc("Breaking Bad - S1 - Disc 1"),
        disc("Breaking Bad - S2 - Disc 2"),
        disc("Breaking Bad - S1 - Disc 2"),
      ],
      { show: "Breaking Bad", tmdbShowId: 1396, includeExtras: true },
    );
    const tvGroups = answers.filter((a): a is TvGroupAnswer => a.kind === "tv-group");
    expect(tvGroups).toHaveLength(2);
    // Seasons emitted in ascending order.
    expect(tvGroups[0]!.season).toBe(1);
    expect(tvGroups[0]!.members.map((m) => m.relPath)).toEqual([
      "Breaking Bad - S1 - Disc 1",
      "Breaking Bad - S1 - Disc 2",
    ]);
    expect(tvGroups[1]!.season).toBe(2);
    for (const g of tvGroups) {
      expect(g.show).toBe("Breaking Bad");
      expect(g.tmdbShowId).toBe(1396);
      expect(g.includeExtras).toBe(true);
    }
  });

  test("season-less discs are preserved as tv singletons carrying the shared show + tmdb_show_id", () => {
    // Was previously "skipped"; that threw the wizard's input away. Now
    // each orphan keeps the shared context and is flagged with a TODO
    // comment in the generated TOML so the user notices and fills in
    // `season = N` rather than starting from a blank file.
    const answers = boxsetAnswers(
      [
        disc("Breaking Bad - S1 - Disc 1"),
        disc("Random Bonus Disc"),
      ],
      { show: "Breaking Bad", tmdbShowId: 1396, includeExtras: false },
    );
    expect(answers.find((a) => a.kind === "skipped")).toBeUndefined();
    const orphan = answers.find(
      (a): a is SingletonAnswer =>
        a.kind === "singleton" &&
        a.type === "tv" &&
        a.member.relPath === "Random Bonus Disc",
    );
    expect(orphan).toBeDefined();
    expect(orphan?.show).toBe("Breaking Bad");
    expect(orphan?.tmdbShowId).toBe(1396);
    expect(orphan?.season).toBeUndefined();
  });

  test("orphan singletons emit a TODO comment about season in the TOML", () => {
    const answers = boxsetAnswers(
      [disc("Bonus Disc")],
      { show: "Breaking Bad", tmdbShowId: 1396, includeExtras: false },
    );
    const blocks = buildBatchBlocks(answers);
    const toml = serializeBatchToml(blocks);
    expect(toml).toContain(`["Bonus Disc"]`);
    expect(toml).toContain("# TODO: set season = N");
    expect(toml).toContain(`tmdb_show_id = 1396`);
    expect(toml).toContain(`show = "Breaking Bad"`);
  });

  test("uses multi-segment paths to find season info in parent dirs", () => {
    // Layout where the parent dir "SHOW_S1_HDBEE" carries the season
    // and the leaf "S1 D1" carries the disc number. Both contribute.
    const answers = boxsetAnswers(
      [
        disc("SHOW_S1_HDBEE/S1 D1"),
        disc("SHOW_S1_HDBEE/S1 D2"),
        disc("SHOW_S2_HDBEE/S2 D1"),
      ],
      { show: "Show Name", tmdbShowId: 12345, includeExtras: false },
    );
    const tvGroups = answers.filter(
      (a): a is TvGroupAnswer => a.kind === "tv-group",
    );
    expect(tvGroups).toHaveLength(2);
    expect(tvGroups[0]!.season).toBe(1);
    expect(tvGroups[0]!.members.map((m) => m.relPath)).toEqual([
      "SHOW_S1_HDBEE/S1 D1",
      "SHOW_S1_HDBEE/S1 D2",
    ]);
    expect(tvGroups[1]!.season).toBe(2);
    for (const g of tvGroups) {
      expect(g.tmdbShowId).toBe(12345);
    }
  });
});

describe("movieDiscsAnswers (whole directory is one movie)", () => {
  test("emits one singleton movie answer per disc, sharing the title/tmdb_id", () => {
    const answers = movieDiscsAnswers(
      [disc("LOTR EE - Disc 1"), disc("LOTR EE - Disc 2")],
      { title: "The Lord of the Rings (2001)", tmdbId: 120, includeExtras: true },
    );
    expect(answers).toHaveLength(2);
    for (const a of answers) {
      expect(a.kind).toBe("singleton");
      const s = a as SingletonAnswer;
      expect(s.type).toBe("movie");
      expect(s.title).toBe("The Lord of the Rings (2001)");
      expect(s.tmdbId).toBe(120);
      expect(s.includeExtras).toBe(true);
    }
  });

  test("omits title/tmdbId when not supplied", () => {
    const answers = movieDiscsAnswers([disc("Disc 1")], { includeExtras: false });
    expect(answers).toHaveLength(1);
    const s = answers[0] as SingletonAnswer;
    expect(s.title).toBeUndefined();
    expect(s.tmdbId).toBeUndefined();
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
