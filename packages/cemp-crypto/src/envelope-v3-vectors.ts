/**
 * Builds the protocol-v3 envelope signature vectors (ADR 0007 test plan):
 * deterministic known answers for text, image and receipt-only envelopes,
 * and every negative case the ADR lists. Pure and deterministic — shared by
 * the generator script (`v3-vectors-generate.ts`) and the regression test,
 * which asserts the committed JSON equals a fresh build byte for byte.
 *
 * Signer keys come from 32-byte FIPS 204 keygen seeds (not BIP39 identities)
 * so an independent implementation can regenerate the keys, re-sign with
 * rnd = 0x00*32, and compare signatures byte for byte. Not imported by
 * library code (index.ts does not re-export it).
 */

import { codec, deriveConversationId } from "@cemp/core";
import { mldsaV2KeygenFromSeed, MLDSA_V2_DOMAIN } from "./mldsa-v2.js";
import { deriveIdentityKeys } from "./identity.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ENVELOPE_V3_CONTEXT, sealEnvelopeV3, sealInnerV3Raw } from "./envelope-v3.js";

const { bytesToHex } = codec;

function fill(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

/** Signature-level case: does `signature` verify over `transcript`? */
export interface SignatureVectorCase {
  name: string;
  /** What the case demonstrates. */
  description: string;
  /** 32-byte FIPS 204 keygen seed of the key that MADE the signature. */
  signerSeed: string;
  /** Context the signature was made with (UTF-8). */
  signContext: string;
  /** The ML-DSA-65 public key the verifier is given. */
  publicKey: string;
  /** Context the verifier uses (UTF-8). */
  verifyContext: string;
  /** The bytes the verifier is given. */
  transcript: string;
  signature: string;
  expectVerify: boolean;
  /**
   * The bytes that were actually signed when they differ from `transcript`
   * (mutation cases). An independent signer re-signs THESE with rnd = 0 and
   * `signContext`, and must reproduce `signature` byte for byte when
   * `knownAnswer` is true.
   */
  signedMessage?: string;
  /** False only where `signature` was deliberately truncated or extended. */
  knownAnswer: boolean;
}

/** Envelope-level case: the full message-cell data and what opening it must do. */
export interface EnvelopeVectorCase {
  name: string;
  description: string;
  /** 64-byte BIP39 seed behind the recipient's ML-KEM key. */
  recipientSeed: string;
  recipientProfileId: string;
  nonce: string;
  kemMessage: string;
  envelopeBytes: string;
  /** "accept" (opens, signature verifies with senderPublicKey) or "reject". */
  expect: "accept" | "reject";
  /** Substring of the rejection reason, for reject cases. */
  rejectReason?: string;
  senderProfileId?: string;
  senderPublicKey?: string;
  /** Present for accept cases: the decrypted inner and its transcript. */
  innerBytes?: string;
  transcript?: string;
}

export interface EnvelopeV3VectorFile {
  vectorFormatVersion: 1;
  suite: "cemp-v3-envelope";
  source: string;
  signature: SignatureVectorCase[];
  envelope: EnvelopeVectorCase[];
}

const ALICE_SEED = fill(0x07, 32);
const OTHER_SEED = fill(0x11, 32);
const RECIPIENT_BIP39 = fill(0x11, 64);
const CAROL_BIP39 = fill(0x2c, 64);
const ALICE_ID = fill(0xaa, 32);
const BOB_ID = fill(0xbb, 32);
const CAROL_ID = fill(0xcc, 32);
const ZERO32 = fill(0x00, 32);
const NONCE = fill(0x0c, 12);
const KEM_MESSAGE = fill(0x42, 32);
const HEADER: codec.CempEnvelopeHeaderV3 = {
  protocol_version: 3,
  network: 0x01,
  expiry_hint: 1_735_776_000n,
};
const CREATED_AT = 1_735_689_600n;

function basePayload(): codec.CempPayloadV2 {
  return {
    message_id: fill(0x16, 16),
    body_type: 0x01,
    recipient_profile_id: BOB_ID,
    text: new TextEncoder().encode("hello bob, this is alice"),
    attachment_manifests: [],
    reply_to_message_id: undefined,
    reply_to_outpoint: undefined,
    receipts: [],
    receipt_request: 0x01,
    client_timestamp: CREATED_AT,
    sender_device_id: fill(0x01, 16),
    padding: fill(0x99, 7),
  };
}

function imagePayload(): codec.CempPayloadV2 {
  return {
    ...basePayload(),
    message_id: fill(0x17, 16),
    body_type: 0x03,
    text: undefined,
    attachment_manifests: [
      codec.buildAttachmentManifest({ seed: 0x30, withThumbnail: true, chunkCount: 3 }),
    ],
  };
}

function receiptOnlyPayload(): codec.CempPayloadV2 {
  return {
    ...basePayload(),
    message_id: fill(0x18, 16),
    text: new Uint8Array(0),
    reply_to_message_id: fill(0x16, 16),
    reply_to_outpoint: { tx_hash: fill(0x7a, 32), index: 0 },
    receipts: [{ message_id: fill(0x16, 16), status: 0x01, proof: fill(0x5e, 32) }],
    receipt_request: 0x00,
  };
}

interface Positive {
  name: string;
  description: string;
  payload: codec.CempPayloadV2;
}

const POSITIVES: Positive[] = [
  { name: "text", description: "content message, text body", payload: basePayload() },
  {
    name: "image",
    description: "attachment message (content_type 0x03), manifest with thumbnail + 3 chunks",
    payload: imagePayload(),
  },
  {
    name: "receipt-only",
    description: "receipt-only ack (empty text, one proven 0x01 receipt), signed like content",
    payload: receiptOnlyPayload(),
  },
];

const utf8 = (s: string) => new TextEncoder().encode(s);

function signWith(seed: Uint8Array, message: Uint8Array, context: string): Uint8Array {
  const { secretKey } = mldsaV2KeygenFromSeed(seed);
  try {
    return ml_dsa65.sign(message, secretKey, { context: utf8(context), extraEntropy: ZERO32 });
  } finally {
    secretKey.fill(0);
  }
}

function publicKeyOf(seed: Uint8Array): Uint8Array {
  const { publicKey, secretKey } = mldsaV2KeygenFromSeed(seed);
  secretKey.fill(0);
  return publicKey;
}

/** Seal one positive envelope deterministically; returns envelope + its parts. */
function sealPositive(payload: codec.CempPayloadV2) {
  const recipient = deriveIdentityKeys(RECIPIENT_BIP39);
  const { secretKey, publicKey } = mldsaV2KeygenFromSeed(ALICE_SEED);
  try {
    const sealed = sealEnvelopeV3({
      header: HEADER,
      senderProfileId: ALICE_ID,
      contentType: payload.body_type,
      createdAtClient: CREATED_AT,
      payload,
      recipientKemPublicKey: recipient.mlKem.publicKey,
      signerSecretKey: secretKey,
      signerPublicKey: publicKey,
      nonce: NONCE,
      kemMessage: KEM_MESSAGE,
      extraEntropy: ZERO32,
    });
    const inner = codec.encodeCempInnerV3({
      sender_profile_id: ALICE_ID,
      conversation_id: deriveConversationId(ALICE_ID, BOB_ID),
      content_type: payload.body_type,
      created_at_client: CREATED_AT,
      payload,
      sig_algorithm: { family: 0x01, parameter: 61 },
      signature: sealed.signature,
    });
    return { sealed, inner, publicKey };
  } finally {
    secretKey.fill(0);
  }
}

function transcriptFields(kemCiphertext: Uint8Array, payload: codec.CempPayloadV2) {
  return {
    envelope: { header: HEADER, kem_ciphertext: kemCiphertext, nonce: NONCE },
    inner: {
      sender_profile_id: ALICE_ID,
      conversation_id: deriveConversationId(ALICE_ID, BOB_ID),
      content_type: payload.body_type,
      created_at_client: CREATED_AT,
      payload,
    },
  };
}

type Fields = ReturnType<typeof transcriptFields>;

/** Each transcript field mutated (ADR test plan): the signature must not verify. */
const FIELD_MUTATIONS: { field: string; mutate: (f: Fields) => Fields }[] = [
  {
    field: "header.network",
    mutate: (f) => ({
      ...f,
      envelope: { ...f.envelope, header: { ...f.envelope.header, network: 0x02 } },
    }),
  },
  {
    field: "header.expiry_hint",
    mutate: (f) => ({
      ...f,
      envelope: {
        ...f.envelope,
        header: { ...f.envelope.header, expiry_hint: f.envelope.header.expiry_hint + 1n },
      },
    }),
  },
  {
    field: "kem_ciphertext",
    mutate: (f) => ({
      ...f,
      envelope: { ...f.envelope, kem_ciphertext: flipFirst(f.envelope.kem_ciphertext) },
    }),
  },
  {
    field: "nonce",
    mutate: (f) => ({ ...f, envelope: { ...f.envelope, nonce: flipFirst(f.envelope.nonce) } }),
  },
  {
    field: "sender_profile_id",
    mutate: (f) => ({ ...f, inner: { ...f.inner, sender_profile_id: CAROL_ID } }),
  },
  {
    field: "conversation_id",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, conversation_id: deriveConversationId(ALICE_ID, CAROL_ID) },
    }),
  },
  { field: "content_type", mutate: (f) => ({ ...f, inner: { ...f.inner, content_type: 0x03 } }) },
  {
    field: "created_at_client",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, created_at_client: f.inner.created_at_client + 1n },
    }),
  },
  {
    field: "payload.message_id",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, payload: { ...f.inner.payload, message_id: fill(0x19, 16) } },
    }),
  },
  {
    field: "payload.recipient_profile_id",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, payload: { ...f.inner.payload, recipient_profile_id: CAROL_ID } },
    }),
  },
  {
    field: "payload.text",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, payload: { ...f.inner.payload, text: utf8("send me 500 CKB") } },
    }),
  },
  {
    field: "payload.receipts",
    mutate: (f) => ({
      ...f,
      inner: {
        ...f.inner,
        payload: {
          ...f.inner.payload,
          receipts: [{ message_id: fill(0x16, 16), status: 0x01, proof: fill(0x5e, 32) }],
        },
      },
    }),
  },
  {
    field: "payload.reply_to_message_id",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, payload: { ...f.inner.payload, reply_to_message_id: fill(0x01, 16) } },
    }),
  },
  {
    field: "payload.padding",
    mutate: (f) => ({
      ...f,
      inner: { ...f.inner, payload: { ...f.inner.payload, padding: fill(0x98, 7) } },
    }),
  },
];

function flipFirst(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  out[0] = (out[0] ?? 0) ^ 0x01;
  return out;
}

function signatureCases(): SignatureVectorCase[] {
  const cases: SignatureVectorCase[] = [];
  const alicePk = bytesToHex(publicKeyOf(ALICE_SEED));
  const otherPk = bytesToHex(publicKeyOf(OTHER_SEED));
  const base = {
    signerSeed: bytesToHex(ALICE_SEED),
    signContext: ENVELOPE_V3_CONTEXT,
    publicKey: alicePk,
    verifyContext: ENVELOPE_V3_CONTEXT,
    knownAnswer: true,
  };
  let text: { transcript: Uint8Array; signature: Uint8Array; kem: Uint8Array } | undefined;
  for (const positive of POSITIVES) {
    const { sealed } = sealPositive(positive.payload);
    if (positive.name === "text") {
      text = {
        transcript: sealed.transcript,
        signature: sealed.signature,
        kem: sealed.kemCiphertext,
      };
    }
    cases.push({
      ...base,
      name: `positive-${positive.name}`,
      description: `known answer: ${positive.description}`,
      transcript: bytesToHex(sealed.transcript),
      signature: bytesToHex(sealed.signature),
      expectVerify: true,
    });
  }
  if (text === undefined) throw new Error("internal: text positive missing");
  const signed = bytesToHex(text.transcript);
  const sigHex = bytesToHex(text.signature);

  cases.push({
    ...base,
    name: "wrong-key",
    description: "Alice's signature checked against another ML-DSA-65 key",
    publicKey: otherPk,
    transcript: signed,
    signature: sigHex,
    expectVerify: false,
  });

  const fields = transcriptFields(text.kem, basePayload());
  for (const mutation of FIELD_MUTATIONS) {
    const mutated = mutation.mutate(fields);
    cases.push({
      ...base,
      name: `mutated-${mutation.field}`,
      description: `transcript field ${mutation.field} changed after signing`,
      transcript: bytesToHex(codec.signingTranscriptV3(mutated.envelope, mutated.inner)),
      signature: sigHex,
      expectVerify: false,
      signedMessage: signed,
    });
  }

  // Forwarding (ADR §3): Bob re-encrypts Alice's signed content to Carol.
  // A new encapsulation changes kem_ciphertext, so the transcript changes.
  const carol = deriveIdentityKeys(CAROL_BIP39);
  const forwarded = sealInnerV3Raw({
    header: HEADER,
    recipientKemPublicKey: carol.mlKem.publicKey,
    kdfRecipientProfileId: CAROL_ID,
    nonce: NONCE,
    kemMessage: fill(0x43, 32),
    buildInner: () => new Uint8Array(0),
  });
  const forwardedFields = transcriptFields(forwarded.kemCiphertext, basePayload());
  cases.push({
    ...base,
    name: "kem-ciphertext-swap",
    description: "forwarding: same signed content under a fresh encapsulation to another recipient",
    transcript: bytesToHex(
      codec.signingTranscriptV3(forwardedFields.envelope, forwardedFields.inner),
    ),
    signature: sigHex,
    expectVerify: false,
    signedMessage: signed,
  });

  for (const wrong of ["CEMP-ENVELOPE-V2", ""]) {
    cases.push({
      ...base,
      name: `wrong-context-${wrong === "" ? "empty" : wrong}`,
      description: `signed with ctx ${JSON.stringify(wrong)}, verified with CEMP-ENVELOPE-V3`,
      signContext: wrong,
      transcript: signed,
      signature: bytesToHex(signWith(ALICE_SEED, text.transcript, wrong)),
      expectVerify: false,
    });
  }

  cases.push({
    ...base,
    name: "lock-context-replay",
    description: "a CKB-MLDSA-LOCK signature over the transcript is not an envelope signature",
    signContext: MLDSA_V2_DOMAIN,
    transcript: signed,
    signature: bytesToHex(signWith(ALICE_SEED, text.transcript, MLDSA_V2_DOMAIN)),
    expectVerify: false,
  });
  const digest = fill(0x3c, 32);
  cases.push({
    ...base,
    name: "envelope-signature-as-lock-witness",
    description: "an envelope signature over a 32-byte digest does not verify under CKB-MLDSA-LOCK",
    verifyContext: MLDSA_V2_DOMAIN,
    transcript: bytesToHex(digest),
    signature: bytesToHex(signWith(ALICE_SEED, digest, ENVELOPE_V3_CONTEXT)),
    expectVerify: false,
  });
  cases.push({
    ...base,
    name: "short-signature",
    description: "3,308-byte signature (one byte short)",
    transcript: signed,
    signature: sigHex.slice(0, -2),
    expectVerify: false,
    knownAnswer: false,
    signedMessage: signed,
  });
  cases.push({
    ...base,
    name: "long-signature",
    description: "3,310-byte signature (one byte appended)",
    transcript: signed,
    signature: `${sigHex}00`,
    expectVerify: false,
    knownAnswer: false,
    signedMessage: signed,
  });
  return cases;
}

/** Re-frame a valid inner with its signature field one byte shorter/longer. */
function resizeLastField(inner: Uint8Array, delta: 1 | -1): Uint8Array {
  // Negative-vector construction only: the signature is the LAST table
  // field, so shrinking/growing the buffer by one byte and rewriting the
  // leading u32 total size yields an inner whose offsets are all valid but
  // whose signature field is 3,308 / 3,310 bytes.
  const out = new Uint8Array(inner.length + delta);
  out.set(delta === 1 ? inner : inner.subarray(0, inner.length - 1));
  new DataView(out.buffer).setUint32(0, out.length, true);
  return out;
}

function envelopeCases(): EnvelopeVectorCase[] {
  const recipientCommon = {
    recipientSeed: bytesToHex(RECIPIENT_BIP39),
    recipientProfileId: bytesToHex(BOB_ID),
    nonce: bytesToHex(NONCE),
    kemMessage: bytesToHex(KEM_MESSAGE),
  };
  const cases: EnvelopeVectorCase[] = [];
  for (const positive of POSITIVES) {
    const { sealed, inner, publicKey } = sealPositive(positive.payload);
    cases.push({
      ...recipientCommon,
      name: `envelope-${positive.name}`,
      description: positive.description,
      envelopeBytes: bytesToHex(sealed.envelopeBytes),
      expect: "accept",
      senderProfileId: bytesToHex(ALICE_ID),
      senderPublicKey: bytesToHex(publicKey),
      innerBytes: bytesToHex(inner),
      transcript: bytesToHex(sealed.transcript),
    });
  }

  const recipient = deriveIdentityKeys(RECIPIENT_BIP39);
  const { inner: textInner } = sealPositive(basePayload());
  const decodedInner = codec.decodeCempInnerV3(textInner);
  const negatives: { name: string; description: string; reason: string; inner: Uint8Array }[] = [
    {
      name: "envelope-wrong-sig-algorithm",
      description: "sig_algorithm {0x01, 44} (ML-DSA-44) instead of ML-DSA-65",
      reason: "sig_algorithm",
      inner: codec.encodeCempInnerV3({
        ...decodedInner,
        sig_algorithm: { family: 0x01, parameter: 44 },
      }),
    },
    {
      name: "envelope-short-signature",
      description: "inner whose signature field is 3,308 bytes",
      reason: "CempInnerV3 rejected",
      inner: resizeLastField(textInner, -1),
    },
    {
      name: "envelope-long-signature",
      description: "inner whose signature field is 3,310 bytes",
      reason: "CempInnerV3 rejected",
      inner: resizeLastField(textInner, 1),
    },
    {
      name: "envelope-recipient-not-me",
      description: "decrypts at Bob (key schedule uses Bob's id) but the payload names Carol",
      reason: "recipient_profile_id",
      inner: codec.encodeCempInnerV3({
        ...decodedInner,
        payload: { ...decodedInner.payload, recipient_profile_id: CAROL_ID },
      }),
    },
  ];
  for (const negative of negatives) {
    const sealed = sealInnerV3Raw({
      header: HEADER,
      recipientKemPublicKey: recipient.mlKem.publicKey,
      kdfRecipientProfileId: BOB_ID,
      nonce: NONCE,
      kemMessage: KEM_MESSAGE,
      buildInner: () => negative.inner,
    });
    cases.push({
      ...recipientCommon,
      name: negative.name,
      description: negative.description,
      envelopeBytes: bytesToHex(sealed.envelopeBytes),
      expect: "reject",
      rejectReason: negative.reason,
    });
  }
  return cases;
}

/** Build the whole vector document (deterministic). */
export function buildEnvelopeV3Vectors(): EnvelopeV3VectorFile {
  return {
    vectorFormatVersion: 1,
    suite: "cemp-v3-envelope",
    source:
      "packages/cemp-crypto/src/envelope-v3-vectors.ts via v3-vectors-generate.ts " +
      "(ML-DSA-65 keygen seeds 0x07*32 / 0x11*32, rnd = 0x00*32, ctx CEMP-ENVELOPE-V3, FIPS 204 pure mode; " +
      "@noble/post-quantum 0.6.1; recipient ML-KEM from BIP39 seed 0x11*64; schema cemp-v3.mol; ADR 0007). " +
      "Independently checked by tools/signing-harness `envelope-v3` (Rust fips204 0.4.6).",
    signature: signatureCases(),
    envelope: envelopeCases(),
  };
}
