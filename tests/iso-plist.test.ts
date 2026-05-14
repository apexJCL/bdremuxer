// Unit test for the hdiutil attach -plist parser. Doesn't spawn hdiutil
// itself — runs the parser against captured XML fixtures so it works on
// any platform.

import { describe, expect, test } from "bun:test";

import { parseAttachPlist } from "../src/disc/iso-macos.ts";

// Typical hdiutil output for a single-volume BD ISO: the outer dict wraps
// a system-entities array with two dicts — the whole-disk entity (no
// mount-point) and the volume entity (with mount-point).
const SINGLE_VOLUME_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>system-entities</key>
\t<array>
\t\t<dict>
\t\t\t<key>content-hint</key>
\t\t\t<string>GUID_partition_scheme</string>
\t\t\t<key>dev-entry</key>
\t\t\t<string>/dev/disk4</string>
\t\t\t<key>potentially-mountable</key>
\t\t\t<false/>
\t\t</dict>
\t\t<dict>
\t\t\t<key>content-hint</key>
\t\t\t<string>Apple_HFS</string>
\t\t\t<key>dev-entry</key>
\t\t\t<string>/dev/disk4s1</string>
\t\t\t<key>mount-point</key>
\t\t\t<string>/tmp/bdremuxer-mounts/dsk1</string>
\t\t\t<key>potentially-mountable</key>
\t\t\t<true/>
\t\t\t<key>volume-kind</key>
\t\t\t<string>udf</string>
\t\t</dict>
\t</array>
</dict>
</plist>`;

describe("parseAttachPlist", () => {
  test("extracts mount-point and dev-entry from a typical hdiutil plist", () => {
    const result = parseAttachPlist(SINGLE_VOLUME_PLIST);
    expect(result).not.toBeNull();
    expect(result!.mountPoint).toBe("/tmp/bdremuxer-mounts/dsk1");
    expect(result!.devEntry).toBe("/dev/disk4s1");
  });

  test("returns null when no system-entity has a mount-point", () => {
    const noMount = SINGLE_VOLUME_PLIST.replace(
      /<key>mount-point<\/key>[\s\S]*?<\/string>/,
      "",
    );
    expect(parseAttachPlist(noMount)).toBeNull();
  });

  test("picks the first system-entity that has a mount-point", () => {
    // Construct a plist where the first mountable entity has the
    // mount-point we expect. The parser should not return entries
    // earlier in the document just because they have a dev-entry.
    const result = parseAttachPlist(SINGLE_VOLUME_PLIST);
    expect(result!.mountPoint).toBe("/tmp/bdremuxer-mounts/dsk1");
    // dev-entry for the same dict, not the outer whole-disk one.
    expect(result!.devEntry).toBe("/dev/disk4s1");
  });
});
