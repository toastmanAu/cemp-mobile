import { describe, expect, it } from "vitest";
import { encodeContactBundle, type ContactBundleV1 } from "./contact-bundle.js";
import { classifyScannedCard, normalizeProfileId } from "./contact-import.js";

const THEIR_ID = "ab".repeat(32);
const MY_ID = "cd".repeat(32);

const BUNDLE: ContactBundleV1 = {
  profileTypeId: `0x${THEIR_ID}`,
  lockScriptHash: `0x${"ef".repeat(32)}`,
  address: `ckt1${"q".repeat(120)}`,
  fingerprint: "ABCD-1234-5678-90AB-CDEF-0123-4567-89AB",
  network: "ckb_testnet",
};

const none = () => undefined;

describe("normalizeProfileId", () => {
  it("strips a 0x prefix and lowercases", () => {
    expect(normalizeProfileId(`0x${"AB".repeat(32)}`)).toBe("ab".repeat(32));
  });

  it("leaves an unprefixed id alone", () => {
    expect(normalizeProfileId(THEIR_ID)).toBe(THEIR_ID);
  });
});

describe("classifyScannedCard", () => {
  it("returns addable for a stranger's valid card", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle(BUNDLE),
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("addable");
    if (out.kind === "addable") expect(out.bundle.fingerprint).toBe(BUNDLE.fingerprint);
  });

  // The prefix asymmetry: the bundle carries 0x, the database does not.
  it("detects a self-card across the 0x prefix boundary", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle({ ...BUNDLE, profileTypeId: `0x${MY_ID}` }),
      myProfileIdHex: MY_ID, // unprefixed, as the database stores it
      findExisting: none,
    });
    expect(out.kind).toBe("self");
  });

  it("detects a duplicate across the 0x prefix boundary", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle(BUNDLE),
      myProfileIdHex: MY_ID,
      // The repository is queried with the UNPREFIXED id.
      findExisting: (id) => (id === THEIR_ID ? { id: 42 } : undefined),
    });
    expect(out.kind).toBe("duplicate");
    if (out.kind === "duplicate") expect(out.existingContactId).toBe(42);
  });

  it("prefers self over duplicate when both would match", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle({ ...BUNDLE, profileTypeId: `0x${MY_ID}` }),
      myProfileIdHex: MY_ID,
      findExisting: () => ({ id: 7 }),
    });
    expect(out.kind).toBe("self");
  });

  it("treats an unpublished own profile as not-self", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle(BUNDLE),
      myProfileIdHex: null,
      findExisting: none,
    });
    expect(out.kind).toBe("addable");
  });

  it("reports 'not-a-card' for junk or an unknown protocol marker", () => {
    for (const text of ["", "not json", "{}", '{"protocol":"nope","version":1}']) {
      const out = classifyScannedCard({ text, myProfileIdHex: MY_ID, findExisting: none });
      expect(out.kind).toBe("unreadable");
      if (out.kind === "unreadable") expect(out.reason).toBe("not-a-card");
    }
  });

  it("reports 'unsupported-version' for a newer CellSend's bundle", () => {
    const out = classifyScannedCard({
      text: JSON.stringify({
        protocol: "cemp-contact",
        version: 2,
        network: "ckb_testnet",
        profileTypeId: BUNDLE.profileTypeId,
        lockScriptHash: BUNDLE.lockScriptHash,
        address: BUNDLE.address,
        fingerprint: BUNDLE.fingerprint,
      }),
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("unreadable");
    if (out.kind === "unreadable") expect(out.reason).toBe("unsupported-version");
  });

  it("reports 'wrong-network' for a wrong-network bundle (rule 11)", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle({ ...BUNDLE, network: "ckb_mainnet" }),
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("unreadable");
    if (out.kind === "unreadable") expect(out.reason).toBe("wrong-network");
  });

  it("reports 'damaged' for a structurally invalid field (bad hex)", () => {
    const out = classifyScannedCard({
      text: JSON.stringify({
        protocol: "cemp-contact",
        version: 1,
        network: "ckb_testnet",
        profileTypeId: "not-hex",
        lockScriptHash: BUNDLE.lockScriptHash,
        address: BUNDLE.address,
        fingerprint: BUNDLE.fingerprint,
      }),
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("unreadable");
    if (out.kind === "unreadable") expect(out.reason).toBe("damaged");
  });

  // decodeContactBundle's own error messages interpolate card-controlled
  // fields (e.g. the scanned "network" string). Forwarding that text to the
  // UI would hand a crafted card control of the error banner. Prove no
  // card-controlled text can reach the outcome at all.
  it("never lets card-controlled text reach the outcome", () => {
    const hostile = JSON.stringify({
      protocol: "cemp-contact",
      version: 1,
      network: "SPOOF-MARKER-XYZ",
      profileTypeId: `0x${THEIR_ID}`,
      lockScriptHash: `0x${"ef".repeat(32)}`,
      address: `ckt1${"q".repeat(120)}`,
      fingerprint: "ABCD-1234-5678-90AB-CDEF-0123-4567-89AB",
    });
    const out = classifyScannedCard({
      text: hostile,
      myProfileIdHex: MY_ID,
      findExisting: () => undefined,
    });
    expect(out.kind).toBe("unreadable");
    expect(JSON.stringify(out)).not.toContain("SPOOF-MARKER-XYZ");
  });

  it("tolerates surrounding whitespace from a paste", () => {
    const out = classifyScannedCard({
      text: `\n  ${encodeContactBundle(BUNDLE)}  \n`,
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("addable");
  });

  it("never lets a decode throw escape", () => {
    expect(() =>
      classifyScannedCard({ text: "�", myProfileIdHex: null, findExisting: none }),
    ).not.toThrow();
  });
});
