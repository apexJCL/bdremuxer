// "90s" / "5m" / "1h" / "false" → seconds, or null for "no filter".
// Returns the raw input on the literal string "false" so callers can opt out.

export function parseDurationFlag(raw: string): number | null {
  if (raw === "false") return null;
  const m = raw.match(/^(\d+)(s|m|h)$/);
  if (!m) throw new Error(`Invalid duration "${raw}". Use N(s|m|h) or "false".`);
  const n = Number(m[1]);
  const unit = m[2]!;
  if (unit === "s") return n;
  if (unit === "m") return n * 60;
  return n * 3600;
}

// "1:49:08" / "5:01" / "90" → seconds. Used to parse MakeMKV's TINFO 9.
export function parseHmsToSeconds(hms: string): number {
  if (!hms) return 0;
  const parts = hms.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return 0;
}

export function formatHms(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}
