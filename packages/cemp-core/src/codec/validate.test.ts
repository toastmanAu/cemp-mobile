/**
 * Spec §12 validation-pipeline tests: positive cases pass, each negative
 * case fails with the expected reason, and no validator ever throws on
 * hostile input.
 */

import { describe, expect, it } from "vitest";
import { CONTENT_TYPE } from "../envelope.js";
import { encodeCempEnvelopeV1, encodeCempPayloadV1, encodeCempProfileV1 } from "./codecs.js";
import {
  buildAttachmentManifest,
  buildEnvelope,
  buildEnvelopeHeader,
  buildPayloadAttachmentManifestsMax,
  buildPayloadMinimal,
  buildPayloadReceiptMax,
  buildPayloadReply,
  buildPayloadText,
  buildPayloadTextMax,
  buildProfileBoundaries,
  buildProfileFull,
  buildProfileMinimal,
  buildReceipts,
} from "./fixtures.js";
import type { ValidationResult } from "./validate.js";
import {
  validateEnvelope,
  validatePayload,
  validateProfile,
  validateSemanticConsistency,
} from "./validate.js";

function expectFail(result: ValidationResult, reason: RegExp): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(reason);
}

describe("validateProfile (spec §5, §11, §12)", () => {
  it("accepts the deterministic valid profiles", () => {
    for (const profile of [buildProfileFull(), buildProfileMinimal(), buildProfileBoundaries()]) {
      expect(validateProfile(encodeCempProfileV1(profile))).toEqual({ ok: true });
    }
  });

  it("rejects an unknown protocol_version", () => {
    const data = encodeCempProfileV1({ ...buildProfileMinimal(), protocol_version: 2 });
    expectFail(validateProfile(data), /unknown protocol_version 2/);
  });

  it("rejects an unknown sig_algorithm family and parameter", () => {
    const badFamily = encodeCempProfileV1({
      ...buildProfileMinimal(),
      sig_algorithm: { family: 0x09, parameter: 61 },
    });
    expectFail(validateProfile(badFamily), /unknown sig_algorithm/);
    const badParameter = encodeCempProfileV1({
      ...buildProfileMinimal(),
      sig_algorithm: { family: 0x01, parameter: 99 },
    });
    expectFail(validateProfile(badParameter), /unknown sig_algorithm/);
  });

  it("rejects an unknown kem_algorithm", () => {
    const data = encodeCempProfileV1({
      ...buildProfileMinimal(),
      kem_algorithm: { family: 0x02, parameter: 2 },
    });
    expectFail(validateProfile(data), /unknown kem_algorithm/);
  });

  it("rejects supported_protocol_versions without v1, empty, or with 9 entries", () => {
    const missing = encodeCempProfileV1({
      ...buildProfileMinimal(),
      supported_protocol_versions: [2],
    });
    expectFail(validateProfile(missing), /does not contain v1/);
    const empty = encodeCempProfileV1({
      ...buildProfileMinimal(),
      supported_protocol_versions: [],
    });
    expectFail(validateProfile(empty), /does not contain v1/);
    const tooMany = encodeCempProfileV1({
      ...buildProfileMinimal(),
      supported_protocol_versions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    expectFail(validateProfile(tooMany), /9 entries/);
  });

  it("rejects a 65-byte handle", () => {
    const data = encodeCempProfileV1({
      ...buildProfileMinimal(),
      handle: new Uint8Array(65).fill(0x68),
    });
    expectFail(validateProfile(data), /handle is 65 bytes/);
  });

  it("rejects profile data over 4096 bytes before decoding", () => {
    const data = encodeCempProfileV1({
      ...buildProfileMinimal(),
      handle: new Uint8Array(1000).fill(0x68),
    });
    expect(data.byteLength).toBeGreaterThan(4096);
    expectFail(validateProfile(data), /exceeds the 4096-byte limit/);
  });

  it("rejects trailing bytes and garbage without throwing", () => {
    const valid = encodeCempProfileV1(buildProfileMinimal());
    const trailing = new Uint8Array([...valid, 0x00]);
    expectFail(validateProfile(trailing), /rejected/);
    expectFail(validateProfile(new Uint8Array([1, 2, 3])), /rejected/);
    expectFail(validateProfile(new Uint8Array(0)), /rejected/);
  });
});

describe("validateEnvelope (spec §7, §11, §12)", () => {
  it("accepts the deterministic valid envelopes", () => {
    for (const envelope of [buildEnvelope(false), buildEnvelope(true)]) {
      expect(validateEnvelope(encodeCempEnvelopeV1(envelope))).toEqual({ ok: true });
    }
  });

  it("rejects cell data over 82,000 bytes before decoding", () => {
    expectFail(validateEnvelope(new Uint8Array(82_001)), /exceeds the 82000-byte limit/);
  });

  it("rejects an unknown protocol_version", () => {
    const data = encodeCempEnvelopeV1({
      ...buildEnvelope(false),
      header: { ...buildEnvelopeHeader(false), protocol_version: 2 },
    });
    expectFail(validateEnvelope(data), /unknown protocol_version 2/);
  });

  it("rejects an unknown network byte", () => {
    const data = encodeCempEnvelopeV1({
      ...buildEnvelope(false),
      header: { ...buildEnvelopeHeader(false), network: 0x02 },
    });
    expectFail(validateEnvelope(data), /unknown network byte 0x02/);
  });

  it("rejects the reserved mainnet network byte (AGENTS.md rule 12)", () => {
    const data = encodeCempEnvelopeV1({
      ...buildEnvelope(false),
      header: { ...buildEnvelopeHeader(false), network: 0x00 },
    });
    expectFail(validateEnvelope(data), /reserved for mainnet/);
  });

  it("rejects an unknown content_type", () => {
    const data = encodeCempEnvelopeV1({
      ...buildEnvelope(false),
      header: { ...buildEnvelopeHeader(false), content_type: 0x09 },
    });
    expectFail(validateEnvelope(data), /unknown content_type 0x09/);
  });

  it("rejects encrypted_payload shorter than the GCM tag", () => {
    const data = encodeCempEnvelopeV1({
      ...buildEnvelope(false),
      encrypted_payload: new Uint8Array(15).fill(0xec),
    });
    expectFail(validateEnvelope(data), /GCM tag/);
  });

  it("rejects truncated and garbage input without throwing", () => {
    const valid = encodeCempEnvelopeV1(buildEnvelope(false));
    expectFail(validateEnvelope(valid.subarray(0, 100)), /rejected/);
    expectFail(validateEnvelope(new Uint8Array(100)), /rejected/);
  });
});

describe("validatePayload (spec §8, §11, §12)", () => {
  it("accepts the deterministic valid payloads, including limit boundaries", () => {
    for (const payload of [
      buildPayloadText(),
      buildPayloadTextMax(), // text exactly 16,384 B
      buildPayloadReceiptMax(), // 64 receipts, 255 B padding
      buildPayloadReply(),
      buildPayloadAttachmentManifestsMax(), // 4 manifests
      buildPayloadMinimal(),
    ]) {
      expect(validatePayload(encodeCempPayloadV1(payload))).toEqual({ ok: true });
    }
  });

  it("rejects text over 16,384 bytes", () => {
    const data = encodeCempPayloadV1({
      ...buildPayloadText(),
      text: new Uint8Array(16_385).fill(0x61),
    });
    expectFail(validatePayload(data), /text is 16385 bytes/);
  });

  it("rejects a payload over 65,536 total bytes whose fields are individually in limit", () => {
    const hugeManifest = {
      ...buildAttachmentManifest({ seed: 0x40, withThumbnail: false, chunkCount: 0 }),
      thumbnail: new Uint8Array(66_000).fill(0x74),
    };
    const data = encodeCempPayloadV1({
      ...buildPayloadMinimal(),
      body_type: CONTENT_TYPE.AttachmentManifest,
      attachment_manifests: [hugeManifest],
    });
    expect(data.byteLength).toBeGreaterThan(65_536);
    expectFail(validatePayload(data), /exceeds the 65536-byte limit/);
  });

  it("rejects padding over 255 bytes", () => {
    const data = encodeCempPayloadV1({
      ...buildPayloadText(),
      padding: new Uint8Array(256).fill(0x77),
    });
    expectFail(validatePayload(data), /padding is 256 bytes/);
  });

  it("rejects 65 receipts", () => {
    const data = encodeCempPayloadV1({
      ...buildPayloadReceiptMax(),
      receipts: buildReceipts(65),
    });
    expectFail(validatePayload(data), /65 receipts/);
  });

  it("rejects 5 attachment manifests", () => {
    const data = encodeCempPayloadV1({
      ...buildPayloadAttachmentManifestsMax(),
      attachment_manifests: [
        ...buildPayloadAttachmentManifestsMax().attachment_manifests,
        buildAttachmentManifest({ seed: 0x7f, withThumbnail: false, chunkCount: 0 }),
      ],
    });
    expectFail(validatePayload(data), /5 attachment manifests/);
  });

  it("rejects a text body with missing text (spec §12.5)", () => {
    const data = encodeCempPayloadV1({ ...buildPayloadText(), text: undefined });
    expectFail(validatePayload(data), /requires the text field/);
  });

  it("rejects garbage without throwing", () => {
    expectFail(validatePayload(new Uint8Array([0xff, 0x00, 0x01])), /rejected/);
    expectFail(validatePayload(new Uint8Array(0)), /rejected/);
  });
});

describe("validateSemanticConsistency (spec §12.5)", () => {
  const header = buildEnvelopeHeader(false);
  const payload = buildPayloadText();
  const ownProfileId = payload.recipient_profile_id;

  it("accepts a consistent header/payload/recipient triple", () => {
    expect(validateSemanticConsistency(header, payload, ownProfileId)).toEqual({ ok: true });
  });

  it("rejects a payload message_id that differs from the header", () => {
    const mismatched = { ...payload, message_id: new Uint8Array(16).fill(0x99) };
    expectFail(
      validateSemanticConsistency(header, mismatched, ownProfileId),
      /message_id does not match/,
    );
  });

  it("rejects a payload body_type that differs from the header content_type", () => {
    const mismatched = { ...payload, body_type: CONTENT_TYPE.Receipt, text: undefined };
    expectFail(
      validateSemanticConsistency(header, mismatched, ownProfileId),
      /body_type .* does not match header content_type/,
    );
  });

  it("rejects a payload addressed to a different recipient", () => {
    const wrongRecipient = new Uint8Array(32).fill(0xee);
    expectFail(
      validateSemanticConsistency(header, payload, wrongRecipient),
      /recipient_profile_id does not match/,
    );
  });

  it("rejects a malformed own profile id without throwing", () => {
    expectFail(validateSemanticConsistency(header, payload, new Uint8Array(3)), /expected 32/);
  });
});
