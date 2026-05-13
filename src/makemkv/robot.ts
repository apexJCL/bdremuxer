// Parser for `makemkvcon --robot` output.
//
// Each line is one of:
//   MSG:code,flags,paramCount,"msg","fmt","p1",...
//   DRV:index,visible,enabled,flags,"name","disc","path"
//   TCOUNT:n
//   CINFO:code,subcode,"value"
//   TINFO:titleIdx,code,subcode,"value"
//   SINFO:titleIdx,streamIdx,code,subcode,"value"
//   PRGT:.../PRGC:.../PRGV:...  (progress; ignored here)
//
// Quoted fields may contain backslash-escaped quotes, backslashes, and
// the usual \n/\t. Numeric fields are bare.

export type ParsedLine =
  | { tag: "MSG"; code: number; flags: number; argc: number; values: string[] }
  | { tag: "DRV"; index: number; visible: number; enabled: number; flags: number; values: string[] }
  | { tag: "TCOUNT"; count: number }
  | { tag: "CINFO"; code: number; subcode: number; value: string }
  | { tag: "TINFO"; title: number; code: number; subcode: number; value: string }
  | { tag: "SINFO"; title: number; stream: number; code: number; subcode: number; value: string }
  | { tag: "OTHER"; raw: string };

export type TitleInfo = {
  index: number;
  info: Map<number, string>;
  streams: Map<number, Map<number, string>>;
};

export type ProbeResult = {
  disc: Map<number, string>;
  titleCount: number;
  titles: Map<number, TitleInfo>;
  messages: string[];
};

export function splitCsv(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inQuote) {
      if (c === "\\" && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === '"' || next === "\\") { buf += next; i++; continue; }
        if (next === "n") { buf += "\n"; i++; continue; }
        if (next === "t") { buf += "\t"; i++; continue; }
        buf += c;
        continue;
      }
      if (c === '"') { inQuote = false; continue; }
      buf += c;
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ",") { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}

export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trimEnd();
  if (trimmed === "") return null;
  const colon = trimmed.indexOf(":");
  if (colon < 0) return { tag: "OTHER", raw: trimmed };
  const tag = trimmed.slice(0, colon);
  const fields = splitCsv(trimmed.slice(colon + 1));

  const n = (i: number): number => {
    const v = fields[i];
    if (v === undefined) return 0;
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const s = (i: number): string => fields[i] ?? "";

  switch (tag) {
    case "MSG":
      return { tag: "MSG", code: n(0), flags: n(1), argc: n(2), values: fields.slice(3) };
    case "DRV":
      return { tag: "DRV", index: n(0), visible: n(1), enabled: n(2), flags: n(3), values: fields.slice(4) };
    case "TCOUNT":
      return { tag: "TCOUNT", count: n(0) };
    case "CINFO":
      return { tag: "CINFO", code: n(0), subcode: n(1), value: s(2) };
    case "TINFO":
      return { tag: "TINFO", title: n(0), code: n(1), subcode: n(2), value: s(3) };
    case "SINFO":
      return { tag: "SINFO", title: n(0), stream: n(1), code: n(2), subcode: n(3), value: s(4) };
    default:
      return { tag: "OTHER", raw: trimmed };
  }
}

export function parseRobotOutput(text: string): ProbeResult {
  const result: ProbeResult = {
    disc: new Map(),
    titleCount: 0,
    titles: new Map(),
    messages: [],
  };

  const ensureTitle = (idx: number): TitleInfo => {
    let t = result.titles.get(idx);
    if (!t) {
      t = { index: idx, info: new Map(), streams: new Map() };
      result.titles.set(idx, t);
    }
    return t;
  };
  const ensureStream = (titleIdx: number, streamIdx: number): Map<number, string> => {
    const t = ensureTitle(titleIdx);
    let s = t.streams.get(streamIdx);
    if (!s) {
      s = new Map();
      t.streams.set(streamIdx, s);
    }
    return s;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    switch (parsed.tag) {
      case "MSG":
        if (parsed.values[0]) result.messages.push(parsed.values[0]);
        break;
      case "TCOUNT":
        result.titleCount = parsed.count;
        break;
      case "CINFO":
        result.disc.set(parsed.code, parsed.value);
        break;
      case "TINFO":
        ensureTitle(parsed.title).info.set(parsed.code, parsed.value);
        break;
      case "SINFO":
        ensureStream(parsed.title, parsed.stream).set(parsed.code, parsed.value);
        break;
      default:
        break;
    }
  }

  return result;
}
