import { describe, expect, it } from "vitest";
import {
  isKeychainBlob,
  keychainBlobFromServiceId,
  serviceIdFromKeychainBlob,
} from "./keychain-blob";

/** Pure blob codec — no React Native imports, runs under plain vitest. */
describe("keychain blob codec", () => {
  it("round-trips a random service id", () => {
    const blob = keychainBlobFromServiceId("0123456789abcdef");
    expect(new TextDecoder().decode(blob)).toBe("ck1.0123456789abcdef");
    expect(isKeychainBlob(blob)).toBe(true);
    expect(serviceIdFromKeychainBlob(blob)).toBe("0123456789abcdef");
  });

  it("rejects malformed ids and blobs", () => {
    expect(() => keychainBlobFromServiceId("xyz")).toThrow();
    expect(() => keychainBlobFromServiceId("0123456789ABCDEF")).toThrow(); // uppercase
    expect(isKeychainBlob(new TextEncoder().encode("ck2.0123456789abcdef"))).toBe(false);
    expect(isKeychainBlob(new TextEncoder().encode("ck1.short"))).toBe(false);
    expect(() => serviceIdFromKeychainBlob(new TextEncoder().encode("garbage"))).toThrow();
  });
});
