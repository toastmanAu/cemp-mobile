import { describe, expect, it } from "vitest";
import { decodeTagCache, encodeTagCache, newOutpoints } from "./route-tag-cache-codec";

/** Pure codec — no React Native imports, runs under plain vitest. */
describe("route tag cache codec", () => {
  it("round-trips tags and lastSeen", () => {
    const cache = { tags: ["aa", "bb", "cc"], lastSeen: ["0xdead:0"] };
    expect(decodeTagCache(encodeTagCache(cache))).toEqual(cache);
  });

  it("decodes an empty cache", () => {
    expect(decodeTagCache(encodeTagCache({ tags: [], lastSeen: [] }))).toEqual({
      tags: [],
      lastSeen: [],
    });
  });

  it("rejects malformed blobs rather than returning junk", () => {
    expect(() => decodeTagCache(new TextEncoder().encode("not json"))).toThrow();
    expect(() => decodeTagCache(new TextEncoder().encode('{"tags":"nope"}'))).toThrow();
    expect(() => decodeTagCache(new TextEncoder().encode('{"tags":[1],"lastSeen":[]}'))).toThrow();
  });

  /* ── security property: the cache never holds the profile id ─────────────── */

  it("encodes no profile id — only the derived tags it was given", () => {
    // Holding the profile id would let anyone reading the cache derive EVERY
    // epoch's route tag, not just the three cached ones. Route tags are
    // derived from it, so the encoded blob must contain the tags and nothing
    // that reconstructs them.
    const profileId = "9f3c1a77b0e54d28aa61ff0490bd7c53";
    const cache = { tags: ["11".repeat(32), "22".repeat(32)], lastSeen: ["0xdead:0"] };

    const encoded = new TextDecoder().decode(encodeTagCache(cache));

    expect(encoded).not.toContain(profileId);
    // Positive counterpart: the fields that ARE meant to be there are, so this
    // cannot pass merely because encoding produced nothing.
    expect(encoded).toContain("11".repeat(32));
    expect(encoded).toContain("0xdead:0");
    // And the blob carries no field beyond the two documented ones.
    expect(Object.keys(JSON.parse(encoded) as object).sort()).toEqual(["lastSeen", "tags"]);
  });

  it("drops any extra field rather than carrying it through a round-trip", () => {
    // A caller passing a wider object (e.g. one carrying a profile id) must
    // not have it persisted.
    const wide = { tags: ["aa"], lastSeen: [], profileId: "9f3c1a77b0e54d28" };
    const encoded = new TextDecoder().decode(encodeTagCache(wide));
    expect(encoded).not.toContain("9f3c1a77b0e54d28");
    expect(decodeTagCache(encodeTagCache(wide))).toEqual({ tags: ["aa"], lastSeen: [] });
  });

  it("reports only outpoints not already seen", () => {
    expect(newOutpoints(["a:0"], ["a:0", "b:0", "c:1"])).toEqual(["b:0", "c:1"]);
  });

  it("reports nothing when everything was already seen", () => {
    expect(newOutpoints(["a:0", "b:0"], ["a:0"])).toEqual([]);
  });
});
