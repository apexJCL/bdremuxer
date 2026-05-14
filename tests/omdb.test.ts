import { describe, expect, test } from "bun:test";
import { OmdbClient } from "../src/metadata/omdb.ts";

// We can't easily test the live OMDb endpoint, but the normalize step in
// OmdbClient is the bit most likely to mishandle real-world inputs.
// Exercising it via the public API requires a fetch shim; for now we keep
// these tests focused on the parsing helpers exported indirectly.
//
// The public OmdbClient surface is small enough that this is mostly a
// smoke-check that the client constructs and the type contract holds.

describe("OmdbClient", () => {
  test("constructs with a key", () => {
    const c = new OmdbClient({ apiKey: "dummy" });
    expect(c).toBeInstanceOf(OmdbClient);
  });
});
