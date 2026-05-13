import { describe, expect, test } from "bun:test";
import {
  formatHms,
  parseDurationFlag,
  parseHmsToSeconds,
} from "../src/parse/duration.ts";

describe("parseDurationFlag", () => {
  test("seconds", () => expect(parseDurationFlag("90s")).toBe(90));
  test("minutes", () => expect(parseDurationFlag("5m")).toBe(300));
  test("hours", () => expect(parseDurationFlag("1h")).toBe(3600));
  test("false disables the filter", () =>
    expect(parseDurationFlag("false")).toBeNull());
  test("rejects garbage", () =>
    expect(() => parseDurationFlag("90")).toThrow());
});

describe("parseHmsToSeconds", () => {
  test("h:m:s", () => expect(parseHmsToSeconds("1:49:08")).toBe(6548));
  test("m:s", () => expect(parseHmsToSeconds("5:01")).toBe(301));
  test("seconds only", () => expect(parseHmsToSeconds("42")).toBe(42));
  test("blank → 0", () => expect(parseHmsToSeconds("")).toBe(0));
});

describe("formatHms", () => {
  test("round-trips", () => expect(formatHms(6548)).toBe("1:49:08"));
  test("pads minutes and seconds", () => expect(formatHms(65)).toBe("0:01:05"));
});
