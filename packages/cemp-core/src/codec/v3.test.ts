/**
 * Protocol version 3 (ADR 0007): sender-signed envelopes. Golden vectors,
 * explicit version dispatch on header field 0 (never try-and-fallback), and
 * the v3 validation pipeline.
 */

import { describe, expect, it } from "vitest";
import vectors from "../../../cemp-test-vectors/vectors/cemp-v3-serialization.json";
import { deriveConversationId } from "../identity.js";
import {
  bytesToHex,
  decodeCempEnvelope,
  decodeCempEnvelopeV1,
  decodeCempEnvelopeV3,
  decodeCempInnerV3,
  encodeCempEnvelopeHeaderV3,
  encodeCempEnvelopeV1,
  encodeCempEnvelopeV3,
  encodeCempInnerV3,
  encodeCempPayloadV2,
  encodeCempSigningTranscriptV3,
  hexToBytes,
  MLDSA65_SIGNATURE_BYTES,
  peekEnvelopeProtocolVersion,
  signingTranscriptV3,
} from "./codecs.js";
import { buildEnvelope } from "./fixtures.js";
import { buildPayloadV2Text } from "./fixtures-v2.js";
import {
  buildEnvelopeV3,
  buildInnerV3,
  buildSigningTranscriptV3,
  CODEC_FIXTURES_V3,
} from "./fixtures-v3.js";
import type { ValidationResult } from "./validate.js";
import { validateEnvelope, validateInnerV3, V3_LIMITS } from "./validate.js";

function expectFail(result: ValidationResult, reason: RegExp): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(reason);
}

interface VectorCase {
  name: string;
  structure: string;
  bytes: string;
}

const fixturesByName = new Map(CODEC_FIXTURES_V3.map((f) => [f.name, f]));

describe("cemp-v3-serialization golden vectors (ADR 0007)", () => {
  it("covers every v3 fixture and names the v3 schema file", () => {
    expect(vectors.vectorFormatVersion).toBe(1);
    expect(vectors.suite).toBe("cemp-v3-serialization");
    expect(vectors.source).toContain("cemp-v3.mol");
    expect(vectors.cases.length).toBe(CODEC_FIXTURES_V3.length);
  });

  for (const c of vectors.cases as VectorCase[]) {
    it(`${c.name} (${c.structure}) round-trips byte-identically`, () => {
      const fixture = fixturesByName.get(c.name);
      if (!fixture) throw new Error(`no v3 fixture for ${c.name}`);
      expect(fixture.structure).toBe(c.structure);
      const decoded = fixture.decode(hexToBytes(c.bytes));
      expect(decoded).toEqual(fixture.value);
      expect(bytesToHex(fixture.encode(decoded))).toBe(c.bytes);
    });
  }
});

describe("v3 wire shape", () => {
  it("the clear header carries only protocol_version, network and expiry_hint", () => {
    const header = encodeCempEnvelopeHeaderV3({
      protocol_version: 3,
      network: 1,
      expiry_hint: 0n,
    });
    // table: 4 total + 3*4 offsets + 1 + 1 + 8
    expect(header.byteLength).toBe(26);
  });

  it("MlDsa65Signature is exactly 3,309 bytes: short and long signatures are rejected", () => {
    expect(MLDSA65_SIGNATURE_BYTES).toBe(3309);
    const inner = buildInnerV3();
    expect(() => encodeCempInnerV3({ ...inner, signature: new Uint8Array(3308) })).toThrow();
    expect(() => encodeCempInnerV3({ ...inner, signature: new Uint8Array(3310) })).toThrow();
    // A hand-patched wire inner whose signature field is one byte short is
    // also refused by the strict decoder (table offsets no longer match).
    const good = encodeCempInnerV3(inner);
    const truncated = good.slice(0, good.byteLength - 1);
    expect(() => decodeCempInnerV3(truncated)).toThrow();
  });

  it("the signing transcript is the Molecule table of the ADR fields, built from the envelope + inner", () => {
    const inner = buildInnerV3();
    const envelope = buildEnvelopeV3();
    const transcript = signingTranscriptV3(envelope, inner);
    expect(bytesToHex(transcript)).toBe(
      bytesToHex(encodeCempSigningTranscriptV3(buildSigningTranscriptV3(inner))),
    );
    // The transcript embeds the exact clear header bytes and the payload bytes.
    const headerHex = bytesToHex(encodeCempEnvelopeHeaderV3(envelope.header));
    const payloadHex = bytesToHex(encodeCempPayloadV2(inner.payload));
    expect(bytesToHex(transcript)).toContain(headerHex);
    expect(bytesToHex(transcript)).toContain(payloadHex);
  });
});

describe("explicit version dispatch on header field 0 (ADR 0007 §4)", () => {
  const v1 = encodeCempEnvelopeV1(buildEnvelope(false));
  const v3 = encodeCempEnvelopeV3(buildEnvelopeV3());

  it("peeks the version byte of v1 and v3 envelopes", () => {
    expect(peekEnvelopeProtocolVersion(v1)).toBe(1);
    expect(peekEnvelopeProtocolVersion(v3)).toBe(3);
  });

  it("peek rejects bytes that are not an envelope-shaped table", () => {
    expect(() => peekEnvelopeProtocolVersion(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => peekEnvelopeProtocolVersion(new Uint8Array(0))).toThrow();
  });

  it("decodes each version with exactly one schema", () => {
    const d3 = decodeCempEnvelope(v3);
    expect(d3.version).toBe(3);
    const d1 = decodeCempEnvelope(v1);
    expect(d1.version).toBe(1);
  });

  it("a v1 layout declaring version 3 is rejected, not re-tried as v1", () => {
    const decoded = decodeCempEnvelopeV1(v1);
    const lying = encodeCempEnvelopeV1({
      ...decoded,
      header: { ...decoded.header, protocol_version: 3 },
    });
    expect(peekEnvelopeProtocolVersion(lying)).toBe(3);
    expect(() => decodeCempEnvelope(lying)).toThrow(/CempEnvelopeV3/);
  });

  it("a v3 layout declaring version 1 or 2 is rejected, not re-tried as v3", () => {
    for (const version of [1, 2]) {
      const lying = encodeCempEnvelopeV3({
        ...buildEnvelopeV3(),
        header: { ...buildEnvelopeV3().header, protocol_version: version },
      });
      expect(() => decodeCempEnvelope(lying)).toThrow(/CempEnvelopeV1/);
    }
  });

  it("any other version is rejected", () => {
    for (const version of [0, 4, 255]) {
      const other = encodeCempEnvelopeV3({
        ...buildEnvelopeV3(),
        header: { ...buildEnvelopeV3().header, protocol_version: version },
      });
      expect(() => decodeCempEnvelope(other)).toThrow(/unknown protocol_version/);
      expectFail(validateEnvelope(other), /protocol_version/);
    }
  });
});

describe("validateEnvelope accepts v3 (key-free, before decapsulation)", () => {
  it("accepts a well-formed v3 envelope", () => {
    expect(validateEnvelope(encodeCempEnvelopeV3(buildEnvelopeV3()))).toEqual({ ok: true });
  });

  it("rejects the reserved mainnet network byte and unknown networks", () => {
    for (const network of [0x00, 0x02]) {
      const bytes = encodeCempEnvelopeV3({
        ...buildEnvelopeV3(),
        header: { ...buildEnvelopeV3().header, network },
      });
      expectFail(validateEnvelope(bytes), /network/);
    }
  });

  it("rejects an encrypted payload shorter than the GCM tag", () => {
    const bytes = encodeCempEnvelopeV3({
      ...buildEnvelopeV3(),
      encrypted_payload: new Uint8Array(15),
    });
    expectFail(validateEnvelope(bytes), /GCM tag/);
  });

  it("decodeCempEnvelopeV3 is strict: trailing bytes are rejected", () => {
    const bytes = encodeCempEnvelopeV3(buildEnvelopeV3());
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes);
    expect(() => decodeCempEnvelopeV3(padded)).toThrow();
  });
});

describe("validateInnerV3 (after AES-GCM, before signature verification)", () => {
  const me = new Uint8Array(32).fill(0x22); // buildPayloadV2Text's recipient
  const sender = new Uint8Array(32).fill(0x33);
  function innerFor(overrides: Partial<ReturnType<typeof buildInnerV3>> = {}) {
    const base = buildInnerV3();
    return encodeCempInnerV3({
      ...base,
      conversation_id: deriveConversationId(sender, me),
      ...overrides,
    });
  }

  it("accepts a well-formed inner addressed to me in the right conversation", () => {
    expect(validateInnerV3(innerFor(), me)).toEqual({ ok: true });
  });

  it("rejects a sig_algorithm other than ML-DSA-65", () => {
    expectFail(
      validateInnerV3(innerFor({ sig_algorithm: { family: 0x01, parameter: 44 } }), me),
      /sig_algorithm/,
    );
    expectFail(
      validateInnerV3(innerFor({ sig_algorithm: { family: 0x02, parameter: 61 } }), me),
      /sig_algorithm/,
    );
  });

  it("rejects recipient_profile_id ≠ me", () => {
    expectFail(validateInnerV3(innerFor(), new Uint8Array(32).fill(0x23)), /recipient_profile_id/);
  });

  it("rejects a conversation_id that is not H(sender, me)", () => {
    expectFail(
      validateInnerV3(innerFor({ conversation_id: new Uint8Array(32) }), me),
      /conversation_id/,
    );
  });

  it("rejects content_type ≠ payload body_type and unknown content types", () => {
    expectFail(validateInnerV3(innerFor({ content_type: 0x03 }), me), /content_type/);
    expectFail(validateInnerV3(innerFor({ content_type: 0x7f }), me), /content_type/);
  });

  it("rejects an inner whose payload breaks the payload limits", () => {
    const payload = { ...buildPayloadV2Text(), padding: new Uint8Array(256) };
    expectFail(validateInnerV3(innerFor({ payload }), me), /padding/);
  });

  it("rejects bytes over the inner limit before decoding", () => {
    expectFail(validateInnerV3(new Uint8Array(V3_LIMITS.maxInnerBytes + 1), me), /exceeds/);
  });

  it("rejects malformed inner bytes without throwing", () => {
    expectFail(validateInnerV3(new Uint8Array([1, 2, 3, 4]), me), /CempInnerV3/);
  });
});
