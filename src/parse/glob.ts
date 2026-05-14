// Minimal glob matcher for batch.toml block keys (§7.1).
//
//   `*`   matches any run of characters except `/`
//   `**`  matches any run of characters including `/`
//   everything else is treated as a literal
//
// No `?`, `[]`, `{}` — keep the surface small until real use cases
// demand more.

export function globToRegex(glob: string): RegExp {
  // Escape regex metacharacters EXCEPT `*` (we'll handle that separately).
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // Use a unique placeholder for `**` so the subsequent `*` substitution
  // doesn't overwrite it.
  const STAR_STAR = "\0GLOBSTAR\0";
  const pattern = escaped
    .replace(/\*\*/g, STAR_STAR)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(STAR_STAR, "g"), ".*");
  return new RegExp(`^${pattern}$`);
}

export function globMatch(glob: string, path: string): boolean {
  return globToRegex(glob).test(path);
}
