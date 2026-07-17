/**
 * Golden-vector generator for CEMP v1 envelope encryption (spec §14).
 *
 * Node-only developer script — never imported by library code. Run:
 *
 *   pnpm --filter @cemp/crypto exec tsx src/vectors-generate.ts
 *
 * Writes `packages/cemp-test-vectors/vectors/cemp-v1-envelope.json`.
 * Fully deterministic: fixed 0x07/0x11-fill BIP39 seeds, fixed envelope nonce
 * and fixed FIPS-203 encapsulation message per case. Regenerating MUST
 * produce byte-identical output (AGENTS.md rule 1 — drift means the codec,
 * the KDF domains or the algorithms changed, and the spec, vectors and
 * serialization version must move together).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codec } from "@cemp/core";
import { decryptEnvelope, encryptEnvelope } from "./envelope.js";
import { deriveIdentityKeys } from "./identity.js";

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

const { bytesToHex } = codec;

interface EnvelopeVectorCase {
  name: string;
  /** 64-byte BIP39 seeds behind the two identities (hex). */
  senderSeed: string;
  recipientSeed: string;
  /** Test-only fixed inputs that make encryption deterministic (spec §14). */
  nonce: string;
  kemMessage: string;
  /** molecule(CempEnvelopeHeaderV1) — also the AEAD AAD (spec §7). */
  headerBytes: string;
  /** molecule(CempPayloadV1) plaintext of encrypted_payload. */
  payloadBytes: string;
  kemCiphertext: string;
  /** molecule(CempEnvelopeV1) — the message-cell data. */
  envelopeBytes: string;
}

function buildCase(options: {
  name: string;
  senderSeed: Uint8Array;
  recipientSeed: Uint8Array;
  nonce: Uint8Array;
  kemMessage: Uint8Array;
  header: codec.CempEnvelopeHeaderV1;
  payload: codec.CempPayloadV1;
}): EnvelopeVectorCase {
  const { name, senderSeed, recipientSeed, nonce, kemMessage, header, payload } = options;
  // Derived to prove both seeds go through the §4 chain; envelope encryption
  // itself encapsulates to the recipient only.
  deriveIdentityKeys(senderSeed);
  const recipient = deriveIdentityKeys(recipientSeed);

  const payloadBytes = codec.encodeCempPayloadV1(payload);
  const headerBytes = codec.encodeCempEnvelopeHeaderV1(header);
  const result = encryptEnvelope({
    payload: payloadBytes,
    recipientKemPublicKey: recipient.mlKem.publicKey,
    header,
    nonce,
    kemMessage,
  });

  // Refuse to write vectors that do not reproduce or round-trip.
  const again = encryptEnvelope({
    payload: payloadBytes,
    recipientKemPublicKey: recipient.mlKem.publicKey,
    header,
    nonce,
    kemMessage,
  });
  if (bytesToHex(again.envelopeBytes) !== bytesToHex(result.envelopeBytes)) {
    throw new Error(`case ${name}: encryption is not deterministic; refusing to write vectors`);
  }
  const opened = decryptEnvelope({
    envelopeBytes: result.envelopeBytes,
    recipientKemSecretKey: recipient.mlKem.secretKey,
    ownProfileId: payload.recipient_profile_id,
  });
  if (bytesToHex(opened.payloadBytes) !== bytesToHex(payloadBytes)) {
    throw new Error(`case ${name}: decrypt round-trip failed; refusing to write vectors`);
  }

  return {
    name,
    senderSeed: bytesToHex(senderSeed),
    recipientSeed: bytesToHex(recipientSeed),
    nonce: bytesToHex(nonce),
    kemMessage: bytesToHex(kemMessage),
    headerBytes: bytesToHex(headerBytes),
    payloadBytes: bytesToHex(payloadBytes),
    kemCiphertext: bytesToHex(result.kemCiphertext),
    envelopeBytes: bytesToHex(result.envelopeBytes),
  };
}

const cases: EnvelopeVectorCase[] = [
  buildCase({
    name: "envelope-text-no-reply",
    senderSeed: fill(0x07, 64),
    recipientSeed: fill(0x11, 64),
    nonce: fill(0x12, 12),
    kemMessage: fill(0x77, 32),
    header: codec.buildEnvelopeHeader(false),
    payload: codec.buildPayloadText(),
  }),
  buildCase({
    name: "envelope-text-reply",
    senderSeed: fill(0x07, 64),
    recipientSeed: fill(0x11, 64),
    nonce: fill(0x34, 12),
    kemMessage: fill(0x88, 32),
    header: codec.buildEnvelopeHeader(true),
    payload: codec.buildPayloadReply(),
  }),
];

const document = {
  vectorFormatVersion: 1,
  suite: "cemp-v1-envelope",
  source:
    "packages/cemp-crypto/src/vectors-generate.ts (fixed identities 0x07/0x11, " +
    "fixed nonce + FIPS-203 encapsulation message; @noble/post-quantum 0.6.1 " +
    "ml_kem768, @noble/ciphers 2.2.0 AES-256-GCM; schema " +
    "packages/cemp-core/schemas/cemp-v1.mol)",
  cases,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../cemp-test-vectors/vectors/cemp-v1-envelope.json");
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${outPath}`);
