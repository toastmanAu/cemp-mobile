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

  it("reports only outpoints not already seen", () => {
    expect(newOutpoints(["a:0"], ["a:0", "b:0", "c:1"])).toEqual(["b:0", "c:1"]);
  });

  it("reports nothing when everything was already seen", () => {
    expect(newOutpoints(["a:0", "b:0"], ["a:0"])).toEqual([]);
  });
});
