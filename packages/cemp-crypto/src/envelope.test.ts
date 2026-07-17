import { codec } from "@cemp/core";
import { describe, expect, it } from "vitest";
import { decryptEnvelope, encryptEnvelope } from "./envelope.js";
import { CempCryptoError } from "./errors.js";
import { deriveIdentityKeys, ML_KEM_768_SIZES } from "./identity.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fixed test identities (deterministic 64-byte BIP39 seeds; sender 0x07,
// recipient 0x11). Envelope encryption encapsulates to the recipient only —
// the sender's keys sign the cell transaction in a later phase.
const recipient = deriveIdentityKeys(new Uint8Array(64).fill(0x11));
const stranger = deriveIdentityKeys(new Uint8Array(64).fill(0x99));

// The deterministic codec fixtures pair up: buildEnvelopeHeader(false) and
// buildPayloadText() share message_id (0x16-filled) and content/body type.
function fixturePayloadBytes(): Uint8Array {
  return codec.encodeCempPayloadV1(codec.buildPayloadText());
}

function ownProfileId(): Uint8Array {
  return codec.buildPayloadText().recipient_profile_id;
}

function encryptBase(nonce?: Uint8Array, kemMessage?: Uint8Array) {
  return encryptEnvelope({
    payload: fixturePayloadBytes(),
    recipientKemPublicKey: recipient.mlKem.publicKey,
    header: codec.buildEnvelopeHeader(false),
    ...(nonce !== undefined ? { nonce } : {}),
    ...(kemMessage !== undefined ? { kemMessage } : {}),
  });
}

function decryptBase(envelopeBytes: Uint8Array, ownId: Uint8Array = ownProfileId()) {
  return decryptEnvelope({
    envelopeBytes,
    recipientKemSecretKey: recipient.mlKem.secretKey,
    ownProfileId: ownId,
  });
}

/** Decode a valid envelope, mutate it, and re-encode. */
function tamperEnvelope(envelopeBytes: Uint8Array, mutate: (env: codec.CempEnvelopeV1) => void) {
  const env = codec.decodeCempEnvelopeV1(envelopeBytes);
  mutate(env);
  return codec.encodeCempEnvelopeV1(env);
}

describe("encryptEnvelope → decryptEnvelope round-trip", () => {
  it("round-trips a fixture payload with production randomness", () => {
    const payloadBytes = fixturePayloadBytes();
    const { envelopeBytes, kemCiphertext, nonce } = encryptBase();

    expect(nonce).toHaveLength(12);
    expect(kemCiphertext).toHaveLength(ML_KEM_768_SIZES.ciphertext);
    // A freshly produced envelope passes the recipient's pre-decrypt pipeline.
    expect(codec.validateEnvelope(envelopeBytes)).toEqual({ ok: true });

    const opened = decryptBase(envelopeBytes);
    expect(bytesToHex(opened.payloadBytes)).toBe(bytesToHex(payloadBytes));
    expect(opened.header).toEqual(codec.buildEnvelopeHeader(false));
  });

  it("uses fresh random nonces unless overridden (spec §7 nonce reuse)", () => {
    const first = encryptBase();
    const second = encryptBase();
    expect(bytesToHex(second.nonce)).not.toBe(bytesToHex(first.nonce));
    expect(bytesToHex(second.envelopeBytes)).not.toBe(bytesToHex(first.envelopeBytes));
    // Both still decrypt — key uniqueness comes from the random nonce/salt.
    expect(decryptBase(first.envelopeBytes).payloadBytes).toEqual(fixturePayloadBytes());
    expect(decryptBase(second.envelopeBytes).payloadBytes).toEqual(fixturePayloadBytes());
  });

  it("is byte-for-byte deterministic with test-only nonce + kemMessage overrides", () => {
    const nonce = new Uint8Array(12).fill(0x42);
    const kemMessage = new Uint8Array(32).fill(0x77);
    const first = encryptBase(nonce, kemMessage);
    const second = encryptBase(nonce, kemMessage);
    expect(bytesToHex(second.envelopeBytes)).toBe(bytesToHex(first.envelopeBytes));
  });

  it("passes the spec §12 semantic pipeline after decryption", () => {
    const { envelopeBytes } = encryptBase();
    const opened = decryptBase(envelopeBytes);
    const payload = codec.decodeCempPayloadV1(opened.payloadBytes);
    expect(codec.validatePayload(opened.payloadBytes)).toEqual({ ok: true });
    expect(codec.validateSemanticConsistency(opened.header, payload, ownProfileId())).toEqual({
      ok: true,
    });
  });

  it("rejects a header/payload message_id mismatch before encrypting", () => {
    const header = codec.buildEnvelopeHeader(false);
    header.message_id = new Uint8Array(16).fill(0x99);
    expect(() =>
      encryptEnvelope({
        payload: fixturePayloadBytes(),
        recipientKemPublicKey: recipient.mlKem.publicKey,
        header,
      }),
    ).toThrow(CempCryptoError);
  });
});

describe("decryptEnvelope tamper battery (spec §12)", () => {
  it("rejects decryption with the wrong recipient secret key", () => {
    const { envelopeBytes } = encryptBase();
    expect(() =>
      decryptEnvelope({
        envelopeBytes,
        recipientKemSecretKey: stranger.mlKem.secretKey,
        ownProfileId: ownProfileId(),
      }),
    ).toThrow(CempCryptoError);
  });

  it("rejects a bit-flipped KEM ciphertext (FIPS-203 implicit rejection → AEAD)", () => {
    const tampered = tamperEnvelope(encryptBase().envelopeBytes, (env) => {
      env.kem_ciphertext[0] = (env.kem_ciphertext[0] ?? 0) ^ 0x01;
    });
    expect(() => decryptBase(tampered)).toThrow(CempCryptoError);
  });

  it("rejects a bit-flipped nonce", () => {
    const tampered = tamperEnvelope(encryptBase().envelopeBytes, (env) => {
      env.nonce[0] = (env.nonce[0] ?? 0) ^ 0x01;
    });
    expect(() => decryptBase(tampered)).toThrow(CempCryptoError);
  });

  it("rejects a bit-flipped AAD field in the header", () => {
    const tampered = tamperEnvelope(encryptBase().envelopeBytes, (env) => {
      env.header.message_id[0] = (env.header.message_id[0] ?? 0) ^ 0x01;
    });
    // The mutated header is still a well-formed envelope, so the failure must
    // come from the AEAD tag check binding the AAD — proof it got past §12.1–3.
    expect(codec.validateEnvelope(tampered)).toEqual({ ok: true });
    expect(() => decryptBase(tampered)).toThrowError(/AES-256-GCM authentication failed/);
  });

  it("rejects a truncated encrypted_payload", () => {
    const tampered = tamperEnvelope(encryptBase().envelopeBytes, (env) => {
      env.encrypted_payload = env.encrypted_payload.slice(
        0,
        Math.ceil(env.encrypted_payload.length / 2),
      );
    });
    expect(() => decryptBase(tampered)).toThrow(CempCryptoError);
  });

  it("rejects an oversized envelope before any decryption (spec §7.2/§11)", () => {
    // Hand-built: 81,500 B of fake payload pushes the cell data past 82,000 B.
    const oversized = codec.encodeCempEnvelopeV1({
      header: codec.buildEnvelopeHeader(false),
      kem_ciphertext: new Uint8Array(1088).fill(0x77),
      nonce: new Uint8Array(12).fill(0x12),
      encrypted_payload: new Uint8Array(81_500).fill(0xec),
    });
    expect(oversized.length).toBeGreaterThan(codec.V1_LIMITS.maxEnvelopeBytes);
    expect(codec.validateEnvelope(oversized).ok).toBe(false);
    expect(() => decryptBase(oversized)).toThrowError(/pre-decrypt validation/);
  });

  it("fails when decrypting with a different ownProfileId (key binding)", () => {
    const { envelopeBytes } = encryptBase();
    const wrongProfileId = new Uint8Array(32).fill(0x33);
    // The recipient id is bound into the message key, so the wrong own id
    // derives a wrong key and the AEAD tag check fails.
    expect(() => decryptBase(envelopeBytes, wrongProfileId)).toThrow(CempCryptoError);
  });

  it("fails semantic consistency for a different ownProfileId when wired through the codec", () => {
    const { envelopeBytes } = encryptBase();
    const opened = decryptBase(envelopeBytes);
    const payload = codec.decodeCempPayloadV1(opened.payloadBytes);
    const wrongProfileId = new Uint8Array(32).fill(0x33);
    const result = codec.validateSemanticConsistency(opened.header, payload, wrongProfileId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/recipient_profile_id/);
    }
  });
});
