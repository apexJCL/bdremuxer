import { describe, expect, test } from "bun:test";
import { parseLine, parseRobotOutput, splitCsv } from "../src/makemkv/robot.ts";

describe("splitCsv", () => {
  test("plain fields", () => {
    expect(splitCsv(`1,2,3`)).toEqual(["1", "2", "3"]);
  });
  test("quoted strings", () => {
    expect(splitCsv(`0,9,0,"1:49:08"`)).toEqual(["0", "9", "0", "1:49:08"]);
  });
  test("escaped quote inside string", () => {
    expect(splitCsv(`"foo \\"bar\\" baz"`)).toEqual([`foo "bar" baz`]);
  });
  test("escaped backslash", () => {
    expect(splitCsv(`"a\\\\b"`)).toEqual(["a\\b"]);
  });
});

describe("parseLine", () => {
  test("TCOUNT", () => {
    expect(parseLine("TCOUNT:23")).toEqual({ tag: "TCOUNT", count: 23 });
  });
  test("CINFO", () => {
    expect(parseLine(`CINFO:2,0,"THE_THING"`)).toEqual({
      tag: "CINFO",
      code: 2,
      subcode: 0,
      value: "THE_THING",
    });
  });
  test("TINFO with duration", () => {
    expect(parseLine(`TINFO:0,9,0,"1:49:08"`)).toEqual({
      tag: "TINFO",
      title: 0,
      code: 9,
      subcode: 0,
      value: "1:49:08",
    });
  });
  test("SINFO", () => {
    expect(parseLine(`SINFO:0,1,3,0,"eng"`)).toEqual({
      tag: "SINFO",
      title: 0,
      stream: 1,
      code: 3,
      subcode: 0,
      value: "eng",
    });
  });
  test("OTHER on unknown tag", () => {
    expect(parseLine("PRGV:1,2,65536")).toEqual({ tag: "OTHER", raw: "PRGV:1,2,65536" });
  });
});

describe("parseRobotOutput", () => {
  const sample = [
    `MSG:1005,0,1,"started"`,
    `CINFO:1,6209,"Blu-ray disc"`,
    `CINFO:2,0,"THE_THING"`,
    `TCOUNT:2`,
    `TINFO:0,8,0,"5"`,
    `TINFO:0,9,0,"1:49:08"`,
    `TINFO:0,10,0,"31.1 GB"`,
    `TINFO:0,11,0,"33420000000"`,
    `TINFO:0,26,0,"00800+00801"`,
    `SINFO:0,0,1,6201,"Video"`,
    `SINFO:0,0,3,0,"eng"`,
    `SINFO:0,0,6,0,"Mpeg4"`,
    `TINFO:1,9,0,"0:05:01"`,
    `TINFO:1,11,0,"1200000000"`,
  ].join("\n");

  const probe = parseRobotOutput(sample);

  test("captures disc CINFO", () => {
    expect(probe.disc.get(2)).toBe("THE_THING");
  });
  test("title count", () => {
    expect(probe.titleCount).toBe(2);
    expect(probe.titles.size).toBe(2);
  });
  test("title 0 fields", () => {
    const t0 = probe.titles.get(0)!;
    expect(t0.info.get(9)).toBe("1:49:08");
    expect(t0.info.get(11)).toBe("33420000000");
    expect(t0.info.get(26)).toBe("00800+00801");
  });
  test("title 0 video stream", () => {
    const s = probe.titles.get(0)!.streams.get(0)!;
    expect(s.get(1)).toBe("Video");
    expect(s.get(3)).toBe("eng");
    expect(s.get(6)).toBe("Mpeg4");
  });
});
