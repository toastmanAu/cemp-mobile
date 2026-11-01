/**
 * Protocol version 2 (ADR 0006): receipts carry a 32-byte proof of
 * decryption. Golden vectors, explicit version dispatch (never
 * try-and-fallback), and the v2 validation pipeline.
 */

import { describe, expect, it } from "vitest";
import v1Vectors from "../../../cemp-test-vectors/vectors/cemp-v1-serialization.json";
import vectors from "../../../cemp-test-vectors/vectors/cemp-v2-serialization.json";
import {
  bytesToHex,
  decodeCempPayload,
  decodeCempPayloadV1,
  decodeCempPayloadV2,
  decodeReceiptEntryV1,
  decodeReceiptEntryV2,
  encodeCempEnvelopeV1,
  encodeCempPayloadV1,
  encodeCempPayloadV2,
  encodeReceiptEntryV1,
  encodeReceiptEntryV2,
  hexToBytes,
} from "./codecs.js";
import { buildEnvelope, buildEnvelopeHeader, buildPayloadText } from "./fixtures.js";
import {
  buildPayloadV2ReceiptMax,
  buildPayloadV2Text,
  buildReceiptEntryV2,
  CODEC_FIXTURES_V2,
} from "./fixtures-v2.js";
import type { ValidationResult } from "./validate.js";
import {
  validateEnvelope,
  validatePayloadForVersion,
  validatePayloadV2,
  validateSemanticConsistency,
} from "./validate.js";

function expectFail(result: ValidationResult, reason: RegExp): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(reason);
}

interface VectorCase {
  name: string;
  structure: string;
  bytes: string;
}

const fixturesByName = new Map(CODEC_FIXTURES_V2.map((f) => [f.name, f]));

describe("cemp-v2-serialization golden vectors (ADR 0006)", () => {
  it("covers every v2 fixture and names both schema files", () => {
    expect(vectors.vectorFormatVersion).toBe(1);
    expect(vectors.suite).toBe("cemp-v2-serialization");
    expect(vectors.source).toContain("cemp-v2.mol");
    expect(vectors.cases.length).toBe(CODEC_FIXTURES_V2.length);
  });

  for (const c of vectors.cases as VectorCase[]) {
    it(`${c.name} (${c.structure}) round-trips byte-identically`, () => {
      const fixture = fixturesByName.get(c.name);
      if (!fixture) throw new Error(`no v2 fixture for ${c.name}`);
      expect(fixture.structure).toBe(c.structure);
      const decoded = fixture.decode(hexToBytes(c.bytes));
      expect(decoded).toEqual(fixture.value);
      expect(bytesToHex(fixture.encode(decoded))).toBe(c.bytes);
      expect(bytesToHex(fixture.encode(fixture.value))).toBe(c.bytes);
    });
  }

  it("leaves the v1 vector suite untouched (historical decoding)", () => {
    expect(v1Vectors.suite).toBe("cemp-v1-serialization");
    expect(v1Vectors.cases.every((c) => !c.structure.endsWith("V2"))).toBe(true);
  });
});

describe("ReceiptEntryV2 is a distinct, strict wire type", () => {
  it("is 32 bytes larger than the v1 entry", () => {
    const v2 = encodeReceiptEntryV2(buildReceiptEntryV2(0x51, 0x01));
    const v1 = encodeReceiptEntryV1({ message_id: new Uint8Array(16).fill(0x51), status: 1 });
    // One extra field: +32 proof bytes, +4 offset-table bytes.
    expect(v2.length - v1.length).toBe(36);
  });

  it("a v1 entry does not decode as v2, nor a v2 entry as v1", () => {
    const v2 = encodeReceiptEntryV2(buildReceiptEntryV2(0x51, 0x01));
    const v1 = encodeReceiptEntryV1({ message_id: new Uint8Array(16).fill(0x51), status: 1 });
    expect(() => decodeReceiptEntryV2(v1)).toThrow();
    expect(() => decodeReceiptEntryV1(v2)).toThrow();
  });

  it("rejects a wrong-length proof on encode", () => {
    expect(() =>
      encodeReceiptEntryV2({ ...buildReceiptEntryV2(1, 1), proof: new Uint8Array(31) }),
    ).toThrow();
  });
});

describe("decodeCempPayload dispatches on protocol_version, no fallback", () => {
  const v1Bytes = encodeCempPayloadV1(buildPayloadText());
  const v2Bytes = encodeCempPayloadV2(buildPayloadV2Text());

  it("1 → CempPayloadV1, 2 → CempPayloadV2", () => {
    const one = decodeCempPayload(1, v1Bytes);
    expect(one.version).toBe(1);
    expect(one.payload).toEqual(decodeCempPayloadV1(v1Bytes));
    const two = decodeCempPayload(2, v2Bytes);
    expect(two.version).toBe(2);
    expect(two.payload).toEqual(decodeCempPayloadV2(v2Bytes));
  });

  it("a v1 payload under version 2 (and vice versa) is rejected, not reinterpreted", () => {
    expect(() => decodeCempPayload(2, v1Bytes)).toThrow(/CempPayloadV2/);
    expect(() => decodeCempPayload(1, v2Bytes)).toThrow(/CempPayloadV1/);
  });

  it("any other version is rejected", () => {
    for (const version of [0, 3, 255]) {
      expect(() => decodeCempPayload(version, v2Bytes)).toThrow(/protocol_version/);
    }
  });

  it("validatePayloadForVersion is total and dispatches the same way", () => {
    expect(validatePayloadForVersion(1, v1Bytes)).toEqual({ ok: true });
    expect(validatePayloadForVersion(2, v2Bytes)).toEqual({ ok: true });
    expectFail(validatePayloadForVersion(2, v1Bytes), /CempPayloadV2 rejected/);
    expectFail(validatePayloadForVersion(1, v2Bytes), /CempPayloadV1 rejected/);
    expectFail(validatePayloadForVersion(3, v2Bytes), /unknown protocol_version 3/);
  });
});

describe("validateEnvelope header protocol_version (ADR 0006)", () => {
  for (const version of [1, 2]) {
    it(`accepts protocol_version ${version}`, () => {
      const data = encodeCempEnvelopeV1({
        ...buildEnvelope(false),
        header: { ...buildEnvelopeHeader(false), protocol_version: version },
      });
      expect(validateEnvelope(data)).toEqual({ ok: true });
    });
  }
  for (const version of [0, 3]) {
    it(`rejects protocol_version ${version}`, () => {
      const data = encodeCempEnvelopeV1({
        ...buildEnvelope(false),
        header: { ...buildEnvelopeHeader(false), protocol_version: version },
      });
      expectFail(validateEnvelope(data), new RegExp(`unknown protocol_version ${version}`));
    });
  }
});

describe("validatePayloadV2 (same limits as v1)", () => {
  it("accepts the boundary fixture (64 receipts, 255 padding)", () => {
    expect(validatePayloadV2(encodeCempPayloadV2(buildPayloadV2ReceiptMax()))).toEqual({
      ok: true,
    });
  });

  it("rejects 65 receipts", () => {
    const max = buildPayloadV2ReceiptMax();
    const data = encodeCempPayloadV2({
      ...max,
      receipts: [...max.receipts, buildReceiptEntryV2(0x7f, 1)],
    });
    expectFail(validatePayloadV2(data), /65 receipts/);
  });

  it("rejects an unknown receipt status", () => {
    const data = encodeCempPayloadV2({
      ...buildPayloadV2Text(),
      receipts: [buildReceiptEntryV2(1, 0xff)],
    });
    expectFail(validatePayloadV2(data), /unknown receipt status/);
  });

  it("semantic consistency accepts a v2 payload", () => {
    const payload = buildPayloadV2Text();
    const header = { ...buildEnvelopeHeader(false), protocol_version: 2 };
    expect(validateSemanticConsistency(header, payload, payload.recipient_profile_id)).toEqual({
      ok: true,
    });
  });
});
