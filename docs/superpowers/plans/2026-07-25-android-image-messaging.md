# Android Image Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `@cemp/images` pipeline into the Android app for a full image round-trip — pick → compress → chunk → publish on-chain → discover → render thumbnail → tap-download full-res — proven on testnet Samsung→Retroid.

**Architecture:** The platform-neutral `@cemp/images` pipeline (compress/encrypt/chunk/manifest/download) is reused untouched. We add: (1) a crypto coordination seam so chunk encryption and the message envelope share one ML-KEM encapsulation; (2) a `publishImageMessage` orchestration in `@cemp/images`; (3) two native Kotlin modules (`CempImageCodec`, `CempImagePicker`) + their JS adapters; (4) app wiring (journal adapter, attachment persistence, `publishImage`); (5) chat UI (attach button, image bubble, tap-to-download).

**Tech Stack:** TypeScript (vitest), React Native 0.83.10 (New Arch, legacy bridge), Kotlin (Gradle 9, compileSdk 36 / minSdk 24), `@noble/post-quantum` ML-KEM-768, `node:sqlite`.

## Global Constraints

- **Bridge marshalling is lowercase hex strings, never base64** — reuse `apps/android/src/platform/hex.ts` (`bytesToHex`/`hexToBytes`). Heavy native work runs on a background `Thread`, settles a `Promise`.
- **Native modules use the legacy bridge** (`ReactContextBaseJavaModule` + `ReactPackage` + `@ReactMethod`), registered manually in `MainApplication.kt`. Do NOT write TurboModule/codegen specs.
- **Package namespace:** `com.cempmobile`. New Kotlin under `apps/android/android/app/src/main/java/com/cempmobile/imaging/`.
- **minSdk = 24, compileSdk/targetSdk = 36.** The system Photo Picker (`ACTION_PICK_IMAGES`) is API 33+; use AndroidX `PickVisualMedia` for back-compat.
- **Protocol limits** (`@cemp/core` `PROTOCOL_LIMITS`): `maxAttachmentBytes = 1_048_576`, `preferredAttachmentBytes = 512_000`, `ATTACHMENT_CHUNK_BYTES = 32_768`, `maxImageLongestEdgePx = 1280`, `preferredImageLongestEdgePx = 960`, `thumbnailLongestEdgePx = 320`.
- **Attachment-key SAFETY INVARIANT (spec §6):** `kemMessage` (32B) + `nonce` (12B) are generated FRESH per message by the orchestration and used for exactly one published envelope. NEVER reuse a pair across envelopes. The app never hand-supplies them.
- **User-facing error copy is jargon-free** (AGENTS.md rule 15). No content leaks in notifications.
- **Immutability, small files, explicit error handling** (repo coding-style rules). New TS files stay focused (<400 lines).
- **Test runner:** `npx vitest run <file>` from the package/app dir. Kotlin gate: `cd apps/android/android && ./gradlew :app:compileDebugKotlin`.

---

## File Structure

**New — `@cemp/crypto`:**
- `packages/cemp-crypto/src/attachment-key.ts` — `deriveSendAttachmentKey` (the send-side key derivation).
- `packages/cemp-crypto/src/attachment-key.test.ts`

**Modified — `@cemp/crypto` / `@cemp/ckb`:**
- `packages/cemp-crypto/src/envelope.ts` — no change (overrides already accepted); re-export helper via `index.ts`.
- `packages/cemp-ckb/src/assemble.ts` — thread `attachmentEnvelope` override into `encryptEnvelope`.
- `packages/cemp-ckb/src/publisher.ts` — add `attachmentEnvelope` to `PublishTextInput`, forward to `assembleTextMessage`.

**New — `@cemp/images`:**
- `packages/cemp-images/src/send-message.ts` — `publishImageMessage` orchestration (C).
- `packages/cemp-images/src/capacity.ts` — capacity pre-flight pure helpers (5A).
- `packages/cemp-images/src/send-message.test.ts`, `packages/cemp-images/src/capacity.test.ts`

**New — Android JS adapters:**
- `apps/android/src/platform/native-image-codec.ts` — `NativeImageCodec` + `HandleTracker`.
- `apps/android/src/platform/native-image-picker.ts` — `pickImage()`.
- `apps/android/src/platform/native-image-codec.test.ts`, `native-image-picker.test.ts`

**New — Android Kotlin:**
- `apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImageCodecModule.kt`
- `apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePickerModule.kt`
- `apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePackage.kt`

**Modified — Android native:**
- `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt` — register package.
- `apps/android/android/app/build.gradle` — add `exifinterface` + `activity-ktx`.

**New — app wiring:**
- `apps/android/src/outgoing-tx-journal.ts` — `OutgoingTxJournalAdapter implements AttachmentChunkJournal`.
- `apps/android/src/outgoing-tx-journal.test.ts`

**Modified — app wiring:**
- `apps/android/src/messaging.ts` — instantiate `AttachmentRepository`, thread into `SyncWorkerDeps`, add `publishImage`.
- `apps/android/package.json` — add `"@cemp/images": "workspace:*"`.
- `packages/cemp-sync/src/workers.ts` — add `attachments` to `SyncWorkerDeps`; persist manifest branch.
- `packages/cemp-sync/src/workers.test.ts` (or existing test file) — persistence-branch test.

**New/Modified — UI:**
- `packages/cemp-ui/src/image-bubble.ts` — `imageBubbleState` view-model (download state machine).
- `packages/cemp-ui/src/image-bubble.test.ts`
- `apps/android/src/screens/chat-screen.tsx` — attach button, image send, image bubble + tap-to-download.

---

## Task 1: `deriveSendAttachmentKey` crypto helper (A)

**Files:**
- Create: `packages/cemp-crypto/src/attachment-key.ts`
- Test: `packages/cemp-crypto/src/attachment-key.test.ts`
- Modify: `packages/cemp-crypto/src/index.ts` (export)

**Interfaces:**
- Consumes: `ml_kem768` (`@noble/post-quantum/ml-kem.js`), `deriveMessageKey` (`./hkdf.js`), `ML_KEM_768_SIZES` (`./identity.js`), `AES_256_GCM_NONCE_BYTES` (`./aead.js`), `CempCryptoError` (`./errors.js`).
- Produces: `deriveSendAttachmentKey(params: DeriveSendAttachmentKeyParams): Uint8Array` and the `DeriveSendAttachmentKeyParams` interface — consumed by Tasks 2, 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cemp-crypto/src/attachment-key.test.ts
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { describe, expect, it } from "vitest";
import { deriveSendAttachmentKey } from "./attachment-key.js";
import { encryptEnvelope, decryptEnvelope } from "./envelope.js";
import { randomBytes } from "./random.js";
import { codec } from "@cemp/core";

describe("deriveSendAttachmentKey", () => {
  it("matches the attachmentKey a receiver derives from the same encapsulation", () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const senderProfileId = new Uint8Array(32).fill(1);
    const recipientProfileId = new Uint8Array(32).fill(2);
    const kemMessage = randomBytes(32);
    const nonce = randomBytes(12);

    const sendKey = deriveSendAttachmentKey({
      recipientKemPublicKey: publicKey,
      kemMessage,
      nonce,
      senderProfileId,
      recipientProfileId,
    });

    // Build a real envelope reusing the SAME kemMessage+nonce (the §6 seam),
    // then decrypt it and confirm the receiver derives the byte-identical key.
    const messageId = new Uint8Array(16).fill(9);
    const payload = codec.encodeCempPayloadV1({
      message_id: messageId,
      body_type: 0x03,
      recipient_profile_id: recipientProfileId,
      attachment_manifests: [],
      receipts: [],
      receipt_request: 0,
      client_timestamp: 0n,
      sender_device_id: new Uint8Array(16).fill(7),
      padding: new Uint8Array(0),
    });
    const header: codec.CempEnvelopeHeaderV1Encodable = {
      protocol_version: 1, network: 0x01, content_type: 0x03,
      message_id: messageId,
      conversation_id: new Uint8Array(32).fill(3),
      sender_profile_id: senderProfileId,
      created_at_client: 0n, expiry_hint: 0n,
    };
    const env = encryptEnvelope({ payload, recipientKemPublicKey: publicKey, header, kemMessage, nonce });
    const dec = decryptEnvelope({
      envelopeBytes: env.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: recipientProfileId,
    });
    expect(Array.from(sendKey)).toEqual(Array.from(dec.attachmentKey));
    expect(sendKey.length).toBe(32);
  });

  it("rejects a wrong-length kemMessage", () => {
    expect(() =>
      deriveSendAttachmentKey({
        recipientKemPublicKey: ml_kem768.keygen().publicKey,
        kemMessage: new Uint8Array(16),
        nonce: new Uint8Array(12),
        senderProfileId: new Uint8Array(32),
        recipientProfileId: new Uint8Array(32),
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-crypto && npx vitest run src/attachment-key.test.ts`
Expected: FAIL — `deriveSendAttachmentKey` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cemp-crypto/src/attachment-key.ts
/**
 * Send-side attachment-key derivation (spec §9.2 + §6 coordination).
 *
 * Attachments are encrypted under a key derived from the SAME ML-KEM
 * encapsulation as the message envelope. The sender must know that key BEFORE
 * publishing chunks, so this helper re-runs the encapsulation with a caller-
 * supplied `kemMessage` (making it deterministic) and derives the attachment
 * key. The message envelope is later sealed with the same `kemMessage`+`nonce`,
 * so the receiver re-derives a byte-identical key on decrypt.
 *
 * SAFETY: `kemMessage`+`nonce` MUST be fresh CSPRNG per message and used for
 * exactly ONE published envelope. Reuse breaks per-envelope key uniqueness.
 */
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { AES_256_GCM_NONCE_BYTES } from "./aead.js";
import { CempCryptoError } from "./errors.js";
import { deriveMessageKey } from "./hkdf.js";
import { ML_KEM_768_SIZES } from "./identity.js";

export interface DeriveSendAttachmentKeyParams {
  readonly recipientKemPublicKey: Uint8Array;
  /** 32-byte FIPS-203 encapsulation message — fresh CSPRNG per message. */
  readonly kemMessage: Uint8Array;
  /** 12-byte envelope nonce — fresh CSPRNG per message. */
  readonly nonce: Uint8Array;
  readonly senderProfileId: Uint8Array;
  readonly recipientProfileId: Uint8Array;
}

function requireLength(label: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new CempCryptoError(`${label} is ${value.length} bytes, expected ${expected}`);
  }
}

export function deriveSendAttachmentKey(params: DeriveSendAttachmentKeyParams): Uint8Array {
  requireLength("recipientKemPublicKey", params.recipientKemPublicKey, ML_KEM_768_SIZES.publicKey);
  requireLength("kemMessage", params.kemMessage, ML_KEM_768_SIZES.sharedSecret);
  requireLength("nonce", params.nonce, AES_256_GCM_NONCE_BYTES);
  requireLength("senderProfileId", params.senderProfileId, 32);
  requireLength("recipientProfileId", params.recipientProfileId, 32);

  let sharedSecret: Uint8Array;
  try {
    ({ sharedSecret } = ml_kem768.encapsulate(params.recipientKemPublicKey, params.kemMessage));
  } catch (e) {
    throw new CempCryptoError("ML-KEM-768 encapsulation failed", e);
  }
  try {
    return deriveMessageKey(
      sharedSecret,
      params.nonce,
      params.senderProfileId,
      params.recipientProfileId,
      "CEMP-ATTACHMENT-KEY-V1",
    );
  } finally {
    sharedSecret.fill(0);
  }
}
```

Add to `packages/cemp-crypto/src/index.ts`:

```ts
export * from "./attachment-key.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cemp-crypto && npx vitest run src/attachment-key.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/cemp-crypto/src/attachment-key.ts packages/cemp-crypto/src/attachment-key.test.ts packages/cemp-crypto/src/index.ts
git commit -m "feat(crypto): deriveSendAttachmentKey for coordinated attachment encryption"
```

---

## Task 2: Thread `attachmentEnvelope` override through `assembleTextMessage` (A)

**Files:**
- Modify: `packages/cemp-ckb/src/assemble.ts`
- Test: `packages/cemp-ckb/src/assemble.test.ts` (add a case; create file if absent)

**Interfaces:**
- Consumes: `deriveSendAttachmentKey` (Task 1), `encryptEnvelope` overrides (`kemMessage`, `nonce`).
- Produces: `AssembleTextMessageParams.attachmentEnvelope?: { kemMessage: Uint8Array; nonce: Uint8Array }` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cemp-ckb/src/assemble.test.ts  (add this test)
import { describe, expect, it } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { deriveSendAttachmentKey } from "@cemp/crypto";
import { decryptEnvelope, randomBytes } from "@cemp/crypto";
import { assembleTextMessage } from "./assemble.js";

describe("assembleTextMessage attachmentEnvelope coordination", () => {
  it("derives an attachmentKey the receiver reproduces", () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const sender = new Uint8Array(32).fill(1);
    const recipient = new Uint8Array(32).fill(2);
    const kemMessage = randomBytes(32);
    const nonce = randomBytes(12);

    const assembled = assembleTextMessage({
      text: "",
      senderProfileId: sender,
      recipientProfileId: recipient,
      recipientKemPublicKey: publicKey,
      senderDeviceId: new Uint8Array(16).fill(7),
      contentType: 0x03,
      attachmentManifests: [],
      attachmentEnvelope: { kemMessage, nonce },
      nowMs: 0,
    });

    const expected = deriveSendAttachmentKey({
      recipientKemPublicKey: publicKey, kemMessage, nonce,
      senderProfileId: sender, recipientProfileId: recipient,
    });
    expect(Array.from(assembled.attachmentKey)).toEqual(Array.from(expected));

    const dec = decryptEnvelope({
      envelopeBytes: assembled.envelopeBytes,
      recipientKemSecretKey: secretKey,
      ownProfileId: recipient,
    });
    expect(Array.from(dec.attachmentKey)).toEqual(Array.from(expected));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-ckb && npx vitest run src/assemble.test.ts`
Expected: FAIL — `attachmentEnvelope` is not a known param, key mismatch (random encapsulation).

- [ ] **Step 3: Write minimal implementation**

In `packages/cemp-ckb/src/assemble.ts`, add to `AssembleTextMessageParams` (after `nowMs`):

```ts
  /**
   * Attachment-key coordination seam (spec §6): fix the envelope's KEM
   * encapsulation + nonce so the sender can pre-derive the attachmentKey for
   * chunk encryption. MUST be fresh CSPRNG per message (no reuse). Supplied
   * ONLY by the image-send orchestration.
   */
  readonly attachmentEnvelope?: { readonly kemMessage: Uint8Array; readonly nonce: Uint8Array };
```

Change the `encryptEnvelope` call (currently lines 115-119) to forward the override:

```ts
  const { envelopeBytes, attachmentKey } = encryptEnvelope({
    payload,
    recipientKemPublicKey: params.recipientKemPublicKey,
    header,
    ...(params.attachmentEnvelope === undefined
      ? {}
      : {
          kemMessage: params.attachmentEnvelope.kemMessage,
          nonce: params.attachmentEnvelope.nonce,
        }),
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cemp-ckb && npx vitest run src/assemble.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cemp-ckb/src/assemble.ts packages/cemp-ckb/src/assemble.test.ts
git commit -m "feat(ckb): thread attachmentEnvelope coordination through assembleTextMessage"
```

---

## Task 3: Forward `attachmentEnvelope` through `publishText` (A)

**Files:**
- Modify: `packages/cemp-ckb/src/publisher.ts`
- Test: `packages/cemp-ckb/src/publisher.test.ts` (add a case)

**Interfaces:**
- Consumes: `AssembleTextMessageParams.attachmentEnvelope` (Task 2).
- Produces: `PublishTextInput.attachmentEnvelope?: { kemMessage: Uint8Array; nonce: Uint8Array }` — consumed by Task 4 via `MessagePublisher.publishText`.

- [ ] **Step 1: Write the failing test** (spy that `publishText` forwards the override to `assembleTextMessage`)

```ts
// packages/cemp-ckb/src/publisher.test.ts  (add this test)
import { describe, expect, it, vi } from "vitest";

// Capture what publishText passes to assembleTextMessage.
const assembleSpy = vi.fn();
vi.mock("./assemble.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assemble.js")>();
  return {
    ...actual,
    assembleTextMessage: (params: unknown) => {
      assembleSpy(params);
      return actual.assembleTextMessage(params as never);
    },
  };
});

// NOTE: import MessagePublisher AFTER the mock is registered.
import { MessagePublisher } from "./publisher.js";

describe("publishText forwards attachmentEnvelope", () => {
  it("passes the coordination override into assembleTextMessage", async () => {
    // Build a MessagePublisher with fakes for store/client/signer/messageType
    // that let assembleTextMessage run but stop before broadcast. Assert the
    // spy received attachmentEnvelope. (See publisher.test.ts existing helpers
    // for the fake store/client factory to reuse.)
    // ...arrange fakes per existing tests in this file...
    // await publisher.publishText({ ..., contentType: 0x03,
    //   attachmentManifests: [manifest],
    //   attachmentEnvelope: { kemMessage, nonce } });
    // expect(assembleSpy).toHaveBeenCalledWith(
    //   expect.objectContaining({ attachmentEnvelope: { kemMessage, nonce } }));
    expect(assembleSpy).toBeDefined();
  });
});
```

> Implementer note: flesh out the arrange block using the existing fake-store/fake-client factory already present in `publisher.test.ts`. The behavioural assertion is `assembleSpy` received `attachmentEnvelope`. If the file has no reusable fakes, assert forwarding by making the fake client throw at `sendTransaction` and checking the spy fired before the throw.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-ckb && npx vitest run src/publisher.test.ts`
Expected: FAIL — `attachmentEnvelope` not forwarded (spy called without it).

- [ ] **Step 3: Write minimal implementation**

In `packages/cemp-ckb/src/publisher.ts`, add to `PublishTextInput` (near `attachmentManifests`, lines 173-176):

```ts
  /**
   * Attachment-key coordination (spec §6). Supply ONLY for 0x03 attachment
   * messages, and ONLY fresh CSPRNG values per message (no reuse). Forwarded
   * verbatim to the envelope so the sealed key matches the chunk key.
   */
  readonly attachmentEnvelope?: { readonly kemMessage: Uint8Array; readonly nonce: Uint8Array };
```

In the `assembleTextMessage({...})` call inside `publishText` (lines 236-249), add:

```ts
        ...(input.attachmentEnvelope === undefined
          ? {}
          : { attachmentEnvelope: input.attachmentEnvelope }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cemp-ckb && npx vitest run src/publisher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cemp-ckb/src/publisher.ts packages/cemp-ckb/src/publisher.test.ts
git commit -m "feat(ckb): forward attachmentEnvelope coordination through publishText"
```

---

## Task 4: `publishImageMessage` orchestration in `@cemp/images` (C)

**Files:**
- Create: `packages/cemp-images/src/send-message.ts`
- Test: `packages/cemp-images/src/send-message.test.ts`
- Modify: `packages/cemp-images/src/index.ts` (export)

**Interfaces:**
- Consumes: `prepareAttachmentChunks`, `publishAttachmentChunks`, `buildManifestForCommittedChunks`, `AttachmentChunkJournal` (`./send.js`); `deriveSendAttachmentKey` (`@cemp/crypto`); `ImageCodec`, `ImageEncodeFormat` (`./codec.js`); types `CempClient`, `MlDsaV2TxSigner`, `CempMessageTypeRef`, `MessagePublisher` (`@cemp/ckb`); `codec` (`@cemp/core`).
- Produces: `publishImageMessage(deps: PublishImageMessageDeps, input: PublishImageMessageInput): Promise<PublishImageMessageResult>` — consumed by Task 13.

- [ ] **Step 1: Write the failing test** (the key-consistency crux — chunks encrypt under a key the receiver reproduces from the produced envelope)

```ts
// packages/cemp-images/src/send-message.test.ts
import { describe, expect, it } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { decryptEnvelope } from "@cemp/crypto";
import { decryptAttachment, joinChunks } from "./encrypt.js";
import { publishImageMessage } from "./send-message.js";
import { FakeCodec } from "./test-helpers.js"; // extract FakeCodec from images.test.ts (Step 3 note)

describe("publishImageMessage", () => {
  it("encrypts chunks under a key the receiver derives from the produced envelope", async () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const sender = new Uint8Array(32).fill(1);
    const recipient = new Uint8Array(32).fill(2);

    let counter = 0;
    const deterministicRandom = (n: number) => new Uint8Array(n).fill(++counter);

    // Fake chain deps: publishAttachmentChunks path is exercised against a fake
    // client that accepts + commits; capture the manifest + envelope override.
    const captured: { publishTextInput?: any } = {};
    const fakePublisher = {
      publishText: async (input: any) => {
        captured.publishTextInput = input;
        return { txHash: "0xmsg", state: "committed" };
      },
    };
    const { fakeClient, fakeSigner, fakeMessageType, fakeJournal } = makeChainFakes(); // see note

    const source = makePngBytes(64, 48); // FakeCodec-decodable fixture
    const result = await publishImageMessage(
      {
        codec: new FakeCodec(),
        client: fakeClient, signer: fakeSigner, messageType: fakeMessageType,
        journal: fakeJournal, publisher: fakePublisher,
        senderProfileId: sender, senderDeviceId: new Uint8Array(16).fill(7),
        randomBytes: deterministicRandom,
      },
      {
        messageRowId: 1, logicalMessageId: "l1",
        recipientProfileIdHex: "0x" + "02".repeat(32),
        recipientKemPublicKey: publicKey, recipientProfileId: recipient,
        sourceBytes: source,
      },
    );

    // The message publish carried a 0x03 manifest + the coordination override.
    expect(captured.publishTextInput.contentType).toBe(0x03);
    expect(captured.publishTextInput.attachmentEnvelope).toBeDefined();
    expect(result.manifest).toBeDefined();

    // Prove key coordination: assemble the real envelope with the captured
    // override, decrypt as the recipient, and use THAT key to decrypt chunks.
    // (assembleTextMessage from @cemp/ckb, reusing captured.attachmentEnvelope.)
    // recipientKey === the key chunks were encrypted under.
    // See note for the concrete assemble+decrypt+decryptAttachment assertion.
    expect(result.messageTxHash).toBe("0xmsg");
  });
});
```

> Implementer notes for Step 1:
> - Extract the `FakeCodec` from `packages/cemp-images/src/images.test.ts` into `packages/cemp-images/src/test-helpers.ts` and import it in both files (DRY). `makePngBytes` already has an equivalent fixture in `images.test.ts` — reuse it.
> - `makeChainFakes()` mirrors the fake client/signer used by the existing `publishAttachmentChunks` test in `images.test.ts` (a `liveClient` that returns committed cells). Reuse that harness.
> - The strong assertion: build an envelope via `assembleTextMessage({ contentType:0x03, attachmentManifests:[result.manifest], attachmentEnvelope: captured.publishTextInput.attachmentEnvelope, ...ids })`, `decryptEnvelope` it with `secretKey`, then `decryptAttachment(joinChunks(prepared.chunks), manifest.encryption_nonce, dec.attachmentKey, manifest.attachment_id)` succeeds. This is the round-trip that proves §6.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-images && npx vitest run src/send-message.test.ts`
Expected: FAIL — `publishImageMessage` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cemp-images/src/send-message.ts
/**
 * Image message send orchestration (spec §6 + §9). Owns the attachment-key
 * coordination: ONE fresh KEM encapsulation drives both the chunk encryption
 * key and the message envelope. Lives here (not in @cemp/ckb) because the
 * reverse dependency would be a cycle.
 */
import type { CempClient, CempMessageTypeRef, MessagePublisher, MlDsaV2TxSigner } from "@cemp/ckb";
import { codec } from "@cemp/core";
import { deriveSendAttachmentKey } from "@cemp/crypto";
import type { ImageCodec, ImageEncodeFormat } from "./codec.js";
import {
  type AttachmentChunkJournal,
  buildManifestForCommittedChunks,
  prepareAttachmentChunks,
  publishAttachmentChunks,
} from "./send.js";

export interface PublishImageMessageDeps {
  readonly codec: ImageCodec;
  readonly client: CempClient;
  readonly signer: MlDsaV2TxSigner;
  readonly messageType: CempMessageTypeRef;
  readonly journal: AttachmentChunkJournal;
  /** Reuses publishText's journal/monitor/resume for the message cell. */
  readonly publisher: Pick<MessagePublisher, "publishText">;
  readonly senderProfileId: Uint8Array;
  readonly senderDeviceId: Uint8Array;
  /** CSPRNG source (injectable for tests). MUST be cryptographically random in prod. */
  readonly randomBytes: (n: number) => Uint8Array;
}

export interface PublishImageMessageInput {
  readonly messageRowId: number;
  readonly logicalMessageId: string;
  readonly recipientProfileIdHex: string;
  readonly recipientKemPublicKey: Uint8Array;
  readonly recipientProfileId: Uint8Array;
  readonly sourceBytes: Uint8Array;
  readonly caption?: string;
  readonly format?: ImageEncodeFormat;
  readonly timeoutMs?: number;
}

export interface PublishImageMessageResult {
  readonly chunksTxHash: string;
  readonly messageTxHash: string;
  readonly manifest: codec.AttachmentManifestV1Encodable;
  readonly chunkCount: number;
  readonly plaintextSize: number;
}

export async function publishImageMessage(
  deps: PublishImageMessageDeps,
  input: PublishImageMessageInput,
): Promise<PublishImageMessageResult> {
  // §6 SAFETY: fresh, single-use encapsulation randomness per message.
  const kemMessage = deps.randomBytes(32);
  const nonce = deps.randomBytes(12);
  const attachmentKey = deriveSendAttachmentKey({
    recipientKemPublicKey: input.recipientKemPublicKey,
    kemMessage,
    nonce,
    senderProfileId: deps.senderProfileId,
    recipientProfileId: input.recipientProfileId,
  });

  try {
    const prepared = await prepareAttachmentChunks(
      deps.codec,
      input.sourceBytes,
      attachmentKey,
      input.format === undefined ? {} : { format: input.format },
    );
    const published = await publishAttachmentChunks(
      { client: deps.client, signer: deps.signer, journal: deps.journal, messageType: deps.messageType },
      prepared,
      input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
    );
    const reclaimGroupId = deps.randomBytes(16);
    const manifest = buildManifestForCommittedChunks({
      chunks: prepared,
      chunksTxHash: published.chunksTxHash,
      reclaimGroupId,
    });
    const messageResult = await deps.publisher.publishText({
      messageRowId: input.messageRowId,
      logicalMessageId: input.logicalMessageId,
      text: input.caption ?? "",
      recipientProfileIdHex: input.recipientProfileIdHex,
      contentType: 0x03,
      attachmentManifests: [manifest],
      attachmentEnvelope: { kemMessage, nonce },
      receiptRequest: 1,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    return {
      chunksTxHash: published.chunksTxHash,
      messageTxHash: messageResult.txHash,
      manifest,
      chunkCount: published.chunkCount,
      plaintextSize: prepared.prepared.bytes.length,
    };
  } finally {
    attachmentKey.fill(0);
    kemMessage.fill(0);
  }
}
```

Add to `packages/cemp-images/src/index.ts`:

```ts
export * from "./send-message.js";
export * from "./capacity.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cemp-images && npx vitest run src/send-message.test.ts`
Expected: PASS — including the key-coordination round-trip.

- [ ] **Step 5: Commit**

```bash
git add packages/cemp-images/src/send-message.ts packages/cemp-images/src/send-message.test.ts packages/cemp-images/src/test-helpers.ts packages/cemp-images/src/index.ts packages/cemp-images/src/images.test.ts
git commit -m "feat(images): publishImageMessage orchestration with §6 key coordination"
```

---

## Task 5: Capacity pre-flight helpers (5A)

**Files:**
- Create: `packages/cemp-images/src/capacity.ts`
- Test: `packages/cemp-images/src/capacity.test.ts`

**Interfaces:**
- Consumes: `ATTACHMENT_CHUNK_BYTES` (`./encrypt.js`), `estimateAttachmentCapacity` + `PreparedImage` (`./prepare.js`).
- Produces: `estimateImageSendShannon(...)`, `hasSufficientCapacity(...)`, `SEND_FEE_RESERVE_SHANNONS`, `CONSERVATIVE_PER_CHUNK_SHANNON`, `CONSERVATIVE_MESSAGE_CELL_SHANNON` — consumed by Task 13.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cemp-images/src/capacity.test.ts
import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_PER_CHUNK_SHANNON,
  estimateImageSendShannon,
  hasSufficientCapacity,
  SEND_FEE_RESERVE_SHANNONS,
} from "./capacity.js";

describe("image send capacity", () => {
  it("sums chunk cells + message cell + fee reserve", () => {
    const required = estimateImageSendShannon({
      chunkCount: 4,
      perChunkShannon: 33_000n * 100_000_000n,
      messageCellShannon: 20_000n * 100_000_000n,
      feeReserveShannon: SEND_FEE_RESERVE_SHANNONS,
    });
    expect(required).toBe(
      4n * (33_000n * 100_000_000n) + 20_000n * 100_000_000n + SEND_FEE_RESERVE_SHANNONS,
    );
  });

  it("blocks when balance is below required", () => {
    expect(hasSufficientCapacity(10n, 11n)).toBe(false);
    expect(hasSufficientCapacity(11n, 11n)).toBe(true);
  });

  it("exposes a conservative per-chunk upper bound covering a full 32 KiB cell", () => {
    // A full chunk cell locks ~its own byte size in CKB; the constant must be
    // an UPPER bound so the pre-flight never false-negatives an affordable send.
    expect(CONSERVATIVE_PER_CHUNK_SHANNON).toBeGreaterThanOrEqual(32_768n * 100_000_000n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-images && npx vitest run src/capacity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cemp-images/src/capacity.ts
/**
 * Pre-flight capacity gate for an image send (spec §4 decision 5A). On-chain
 * storage costs ~1 CKB per byte, so an image locks roughly its own size in CKB.
 * This estimates the required locked capacity BEFORE building the tx, so an
 * under-funded wallet fails fast with no stranded pending row. The real tx
 * build enforces exact capacity; this is a conservative UPPER bound so it never
 * blocks an affordable send.
 */
const SHANNON_PER_CKB = 100_000_000n;

/** 1 CKB fee reserve (pessimistic; real fee is far smaller). */
export const SEND_FEE_RESERVE_SHANNONS = 1n * SHANNON_PER_CKB;

/**
 * Upper-bound capacity for one full chunk cell: 32 KiB data + generous cell
 * overhead (capacity field + ML-DSA lock + type script ≈ 256 bytes). Task 13
 * may refine from the actual built cell; this bound guarantees no false "OK".
 */
export const CONSERVATIVE_PER_CHUNK_SHANNON = (32_768n + 256n) * SHANNON_PER_CKB;

/**
 * Upper-bound capacity for the manifest-carrying message cell: the envelope +
 * manifest (incl. ≤32 KiB thumbnail) + cell overhead, bounded generously.
 */
export const CONSERVATIVE_MESSAGE_CELL_SHANNON = (32_768n + 4_096n) * SHANNON_PER_CKB;

export function estimateImageSendShannon(input: {
  readonly chunkCount: number;
  readonly perChunkShannon: bigint;
  readonly messageCellShannon: bigint;
  readonly feeReserveShannon: bigint;
}): bigint {
  return (
    BigInt(input.chunkCount) * input.perChunkShannon +
    input.messageCellShannon +
    input.feeReserveShannon
  );
}

export function hasSufficientCapacity(availableShannon: bigint, requiredShannon: bigint): boolean {
  return availableShannon >= requiredShannon;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cemp-images && npx vitest run src/capacity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cemp-images/src/capacity.ts packages/cemp-images/src/capacity.test.ts
git commit -m "feat(images): pre-flight capacity estimate for image sends (5A)"
```

---

## Task 6: `NativeImageCodec` + `HandleTracker` JS adapter

**Files:**
- Create: `apps/android/src/platform/native-image-codec.ts`
- Test: `apps/android/src/platform/native-image-codec.test.ts`
- Modify: `apps/android/package.json` (add `"@cemp/images": "workspace:*"`)

**Interfaces:**
- Consumes: `NativeModules` (`react-native`), `bytesToHex`/`hexToBytes` (`./hex`), `ImageCodec`/`DecodedImage`/`ImageEncodeFormat` (`@cemp/images`).
- Produces: `class NativeImageCodec implements ImageCodec`, `class HandleTracker implements ImageCodec` (decorator with `releaseAll()`) — consumed by Task 13. The native bridge contract `CempImageCodecNativeModule` — consumed by Task 8 (Kotlin must match).

- [ ] **Step 1: Add the dependency**

In `apps/android/package.json` dependencies, add `"@cemp/images": "workspace:*"`. Run `pnpm install` at repo root.

- [ ] **Step 2: Write the failing test**

```ts
// apps/android/src/platform/native-image-codec.test.ts
import { describe, expect, it, vi } from "vitest";

// Mock the RN native module BEFORE importing the adapter.
const decode = vi.fn();
const resize = vi.fn();
const encode = vi.fn();
const release = vi.fn();
vi.mock("react-native", () => ({
  NativeModules: { CempImageCodec: { decode, resize, encode, release } },
}));

import { HandleTracker, NativeImageCodec } from "./native-image-codec.js";
import { bytesToHex } from "./hex.js";

function reset() {
  decode.mockReset(); resize.mockReset(); encode.mockReset(); release.mockReset();
}

describe("NativeImageCodec", () => {
  it("decodes via hex bridge and maps the handle to DecodedImage.pixels", async () => {
    reset();
    decode.mockResolvedValue({ handle: 7, width: 64, height: 48 });
    const codec = new NativeImageCodec();
    const img = await codec.decode(new Uint8Array([1, 2, 3]));
    expect(decode).toHaveBeenCalledWith(bytesToHex(new Uint8Array([1, 2, 3])));
    expect(img).toEqual({ width: 64, height: 48, pixels: 7 });
  });

  it("encodes a handle to bytes", async () => {
    reset();
    encode.mockResolvedValue("ffd8ff");
    const codec = new NativeImageCodec();
    const out = await codec.encode({ width: 1, height: 1, pixels: 7 }, "jpeg", 80);
    expect(encode).toHaveBeenCalledWith(7, "jpeg", 80);
    expect(Array.from(out)).toEqual([0xff, 0xd8, 0xff]);
  });

  it("throws a clear error when the module is not linked", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({ NativeModules: {} }));
    const { NativeImageCodec: Unlinked } = await import("./native-image-codec.js");
    await expect(new Unlinked().decode(new Uint8Array())).rejects.toThrow(/not linked/);
  });
});

describe("HandleTracker release-on-error (aliasing-safe)", () => {
  it("releases every DISTINCT handle exactly once when encode throws", async () => {
    reset();
    // decode -> handle 1; resize -> handle 2; resize returning SAME handle (alias) -> 1; encode throws.
    decode.mockResolvedValue({ handle: 1, width: 10, height: 10 });
    resize
      .mockResolvedValueOnce({ handle: 2, width: 8, height: 8 })
      .mockResolvedValueOnce({ handle: 1, width: 10, height: 10 }); // alias of decode
    encode.mockRejectedValue(new Error("boom"));
    release.mockResolvedValue(undefined);

    const tracker = new HandleTracker(new NativeImageCodec());
    const a = await tracker.decode(new Uint8Array([9]));
    await tracker.resize(a, 8, 8);
    await tracker.resize(a, 10, 10);
    await expect(tracker.encode(a, "webp", 50)).rejects.toThrow("boom");
    await tracker.releaseAll();

    // Distinct handles {1, 2} each released exactly once — no double free of 1.
    const released = release.mock.calls.map((c) => c[0]).sort();
    expect(released).toEqual([1, 2]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/android && npx vitest run src/platform/native-image-codec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// apps/android/src/platform/native-image-codec.ts
import { NativeModules } from "react-native";
import type { DecodedImage, ImageCodec, ImageEncodeFormat } from "@cemp/images";
import { bytesToHex, hexToBytes } from "./hex.js";

interface DecodeResult { handle: number; width: number; height: number }

interface CempImageCodecNativeModule {
  decode(bytesHex: string): Promise<DecodeResult>;
  resize(handle: number, width: number, height: number): Promise<DecodeResult>;
  encode(handle: number, format: ImageEncodeFormat, quality: number): Promise<string>;
  release(handle: number): Promise<void>;
}

/** Bridge-backed codec. `DecodedImage.pixels` carries the native bitmap handle (int). */
export class NativeImageCodec implements ImageCodec {
  #module(): CempImageCodecNativeModule {
    const m = NativeModules.CempImageCodec as CempImageCodecNativeModule | undefined;
    if (m === undefined) {
      throw new Error("NativeImageCodec: the CempImageCodec native module is not linked");
    }
    return m;
  }

  async decode(bytes: Uint8Array): Promise<DecodedImage> {
    const r = await this.#module().decode(bytesToHex(bytes));
    return { width: r.width, height: r.height, pixels: r.handle };
  }

  async resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    const r = await this.#module().resize(image.pixels as number, width, height);
    return { width: r.width, height: r.height, pixels: r.handle };
  }

  async encode(image: DecodedImage, format: ImageEncodeFormat, quality: number): Promise<Uint8Array> {
    return hexToBytes(await this.#module().encode(image.pixels as number, format, quality));
  }

  async release(handle: number): Promise<void> {
    await this.#module().release(handle);
  }
}

/**
 * Decorator that records every DISTINCT native handle produced by decode/resize
 * and releases each exactly once via `releaseAll()`. The @cemp/images pipeline
 * performs ZERO cleanup and may alias handles (compress can return its input),
 * so callers wrap the codec, run `prepareAttachmentChunks`, and `releaseAll()`
 * in a `finally` — covering both success and the throw path (spec §4 item 4).
 */
export class HandleTracker implements ImageCodec {
  readonly #inner: NativeImageCodec;
  readonly #handles = new Set<number>();

  constructor(inner: NativeImageCodec) {
    this.#inner = inner;
  }

  #track(image: DecodedImage): DecodedImage {
    if (typeof image.pixels === "number") {
      this.#handles.add(image.pixels);
    }
    return image;
  }

  async decode(bytes: Uint8Array): Promise<DecodedImage> {
    return this.#track(await this.#inner.decode(bytes));
  }

  async resize(image: DecodedImage, width: number, height: number): Promise<DecodedImage> {
    return this.#track(await this.#inner.resize(image, width, height));
  }

  async encode(image: DecodedImage, format: ImageEncodeFormat, quality: number): Promise<Uint8Array> {
    return this.#inner.encode(image, format, quality);
  }

  /** Release every distinct handle once. Best-effort: a failed release never masks the primary error. */
  async releaseAll(): Promise<void> {
    for (const handle of this.#handles) {
      try {
        await this.#inner.release(handle);
      } catch {
        // Native side recycles defensively; a leaked handle is not fatal.
      }
    }
    this.#handles.clear();
  }
}
```

- [ ] **Step 5: Run test to verify it passes, then commit**

Run: `cd apps/android && npx vitest run src/platform/native-image-codec.test.ts`
Expected: PASS.

```bash
git add apps/android/src/platform/native-image-codec.ts apps/android/src/platform/native-image-codec.test.ts apps/android/package.json pnpm-lock.yaml
git commit -m "feat(android): NativeImageCodec adapter + aliasing-safe HandleTracker"
```

---

## Task 7: `pickImage` picker adapter

**Files:**
- Create: `apps/android/src/platform/native-image-picker.ts`
- Test: `apps/android/src/platform/native-image-picker.test.ts`

**Interfaces:**
- Consumes: `NativeModules`, `hexToBytes`.
- Produces: `pickImage(): Promise<Uint8Array | null>` — consumed by Task 15. Native contract `CempImagePickerNativeModule.pick(): Promise<string | null>` — consumed by Task 9 (Kotlin must match).

- [ ] **Step 1: Write the failing test**

```ts
// apps/android/src/platform/native-image-picker.test.ts
import { describe, expect, it, vi } from "vitest";
const pick = vi.fn();
vi.mock("react-native", () => ({ NativeModules: { CempImagePicker: { pick } } }));
import { pickImage } from "./native-image-picker.js";

describe("pickImage", () => {
  it("returns bytes when the user picks", async () => {
    pick.mockResolvedValue("ffd8ff");
    expect(Array.from((await pickImage())!)).toEqual([0xff, 0xd8, 0xff]);
  });
  it("returns null when the user cancels", async () => {
    pick.mockResolvedValue(null);
    expect(await pickImage()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && npx vitest run src/platform/native-image-picker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/android/src/platform/native-image-picker.ts
import { NativeModules } from "react-native";
import { hexToBytes } from "./hex.js";

interface CempImagePickerNativeModule {
  /** Launch the system Photo Picker. Resolves image bytes as hex, or null on cancel. */
  pick(): Promise<string | null>;
}

export async function pickImage(): Promise<Uint8Array | null> {
  const m = NativeModules.CempImagePicker as CempImagePickerNativeModule | undefined;
  if (m === undefined) {
    throw new Error("pickImage: the CempImagePicker native module is not linked");
  }
  const hex = await m.pick();
  return hex === null ? null : hexToBytes(hex);
}
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `cd apps/android && npx vitest run src/platform/native-image-picker.test.ts`
Expected: PASS.

```bash
git add apps/android/src/platform/native-image-picker.ts apps/android/src/platform/native-image-picker.test.ts
git commit -m "feat(android): pickImage adapter for the system Photo Picker"
```

---

## Task 8: `CempImageCodecModule.kt` (native codec, compile gate)

**Files:**
- Create: `apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImageCodecModule.kt`

**Interfaces:**
- Consumes: the JS contract from Task 6 — `decode(bytesHex): {handle,width,height}`, `resize(handle,w,h): {handle,width,height}`, `encode(handle,format,quality): hex`, `release(handle)`.
- Produces: a `getName() == "CempImageCodec"` module. Registered by Task 9.

- [ ] **Step 1: Write the module** (no Kotlin unit tests by precedent; the deliverable is the file + the Task 9 compile gate)

```kotlin
// apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImageCodecModule.kt
package com.cempmobile.imaging

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native image codec (spec §9.1 + design §1). Holds decoded bitmaps in a
 * handle registry keyed by int; JS drives decode -> resize -> encode -> release.
 * decode() BAKES EXIF orientation into pixels and re-encode drops ALL metadata
 * by construction (task 2 security guarantee). Bytes cross the bridge as hex.
 */
class CempImageCodecModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val bitmaps = ConcurrentHashMap<Int, Bitmap>()
  private val nextHandle = AtomicInteger(1)

  override fun getName(): String = "CempImageCodec"

  @ReactMethod
  fun decode(bytesHex: String, promise: Promise) {
    Thread {
      try {
        val bytes = hexToBytes(bytesHex)
        val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
          ?: throw IllegalArgumentException("decode: not a decodable image")
        val oriented = applyExifOrientation(raw, bytes)
        promise.resolve(store(oriented))
      } catch (e: Throwable) {
        promise.reject("image-decode-error", "could not decode image", asException(e))
      }
    }.start()
  }

  @ReactMethod
  fun resize(handle: Int, width: Int, height: Int, promise: Promise) {
    Thread {
      try {
        val src = bitmaps[handle] ?: throw IllegalStateException("resize: unknown handle $handle")
        val scaled = Bitmap.createScaledBitmap(src, width, height, true)
        promise.resolve(store(scaled))
      } catch (e: Throwable) {
        promise.reject("image-resize-error", "could not resize image", asException(e))
      }
    }.start()
  }

  @ReactMethod
  fun encode(handle: Int, format: String, quality: Int, promise: Promise) {
    Thread {
      try {
        val bmp = bitmaps[handle] ?: throw IllegalStateException("encode: unknown handle $handle")
        val fmt = when (format) {
          "jpeg" -> Bitmap.CompressFormat.JPEG
          "webp" -> if (android.os.Build.VERSION.SDK_INT >= 30)
            Bitmap.CompressFormat.WEBP_LOSSY else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
          else -> throw IllegalArgumentException("encode: unsupported format $format")
        }
        val out = ByteArrayOutputStream()
        if (!bmp.compress(fmt, quality, out)) throw IllegalStateException("encode: compress failed")
        promise.resolve(bytesToHex(out.toByteArray()))
      } catch (e: Throwable) {
        promise.reject("image-encode-error", "could not encode image", asException(e))
      }
    }.start()
  }

  @ReactMethod
  fun release(handle: Int, promise: Promise) {
    try {
      bitmaps.remove(handle)?.recycle()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("image-release-error", "could not release image", asException(e))
    }
  }

  private fun store(bitmap: Bitmap): WritableMap {
    val handle = nextHandle.getAndIncrement()
    bitmaps[handle] = bitmap
    return Arguments.createMap().apply {
      putInt("handle", handle)
      putInt("width", bitmap.width)
      putInt("height", bitmap.height)
    }
  }

  private fun applyExifOrientation(bitmap: Bitmap, bytes: ByteArray): Bitmap {
    val exif = ExifInterface(ByteArrayInputStream(bytes))
    val orientation = exif.getAttributeInt(
      ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
    )
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
    if (rotated != bitmap) bitmap.recycle()
    return rotated
  }

  private fun asException(e: Throwable): Exception? = if (e is Exception) e else null

  companion object {
    fun hexToBytes(hex: String): ByteArray {
      val out = ByteArray(hex.length / 2)
      for (i in out.indices) {
        out[i] = ((Character.digit(hex[2 * i], 16) shl 4) + Character.digit(hex[2 * i + 1], 16)).toByte()
      }
      return out
    }
    fun bytesToHex(bytes: ByteArray): String {
      val sb = StringBuilder(bytes.size * 2)
      for (b in bytes) sb.append("%02x".format(b.toInt() and 0xff))
      return sb.toString()
    }
  }
}
```

- [ ] **Step 2: Commit** (compile gate runs in Task 9 after deps + package + registration land together)

```bash
git add apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImageCodecModule.kt
git commit -m "feat(android): CempImageCodec native module (EXIF-stripping bitmap registry)"
```

---

## Task 9: `CempImagePickerModule.kt` + package + gradle deps + registration (compile gate)

**Files:**
- Create: `apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePickerModule.kt`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePackage.kt`
- Modify: `apps/android/android/app/build.gradle` (deps)
- Modify: `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt` (register)

**Interfaces:**
- Consumes: JS contract from Task 7 — `pick(): Promise<hex | null>`.
- Produces: `getName() == "CempImagePicker"`; `CempImagePackage` returning both imaging modules; app registration.

- [ ] **Step 1: Add gradle dependencies**

In `apps/android/android/app/build.gradle` `dependencies { ... }`, add:

```gradle
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation("androidx.activity:activity-ktx:1.9.3")
```

- [ ] **Step 2: Write the picker module** (novel: `ActivityEventListener` + pending-promise + PickVisualMedia back-compat)

```kotlin
// apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePickerModule.kt
package com.cempmobile.imaging

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream

/**
 * System Photo Picker (design §1). No storage permission on API 33+; AndroidX
 * PickVisualMedia shims older versions. Returns raw image bytes as hex, or null
 * when the user cancels. Holds one pending promise across the activity result.
 */
class CempImagePickerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private var pending: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "CempImagePicker"

  @ReactMethod
  fun pick(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("image-pick-error", "no foreground activity to launch the picker")
      return
    }
    // Reject any prior in-flight pick before starting a new one.
    pending?.reject("image-pick-cancelled", "superseded by a new pick")
    pending = promise
    try {
      val request = PickVisualMediaRequest.Builder()
        .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
        .build()
      val intent = ActivityResultContracts.PickVisualMedia().createIntent(activity, request)
      activity.startActivityForResult(intent, REQUEST_CODE)
    } catch (e: Throwable) {
      pending = null
      promise.reject("image-pick-error", "could not launch the photo picker", if (e is Exception) e else null)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val promise = pending ?: return
    pending = null
    if (resultCode != Activity.RESULT_OK) {
      promise.resolve(null) // cancel -> null (spec §4 item 2)
      return
    }
    val uri: Uri? = data?.data
    if (uri == null) {
      promise.resolve(null)
      return
    }
    Thread {
      try {
        val bytes = readAllBytes(activity, uri)
        promise.resolve(CempImageCodecModule.bytesToHex(bytes))
      } catch (e: Throwable) {
        promise.reject("image-pick-read-error", "could not read the selected image", if (e is Exception) e else null)
      }
    }.start()
  }

  override fun onNewIntent(intent: Intent?) { /* not used */ }

  private fun readAllBytes(activity: Activity, uri: Uri): ByteArray {
    activity.contentResolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "could not open the selected image stream" }
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        out.write(buf, 0, n)
      }
      return out.toByteArray()
    }
  }

  companion object {
    private const val REQUEST_CODE = 0xC0DE
  }
}
```

- [ ] **Step 3: Write the package**

```kotlin
// apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePackage.kt
package com.cempmobile.imaging

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CempImagePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CempImageCodecModule(reactContext), CempImagePickerModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
```

- [ ] **Step 4: Register in `MainApplication.kt`**

Add the import alongside the others:

```kotlin
import com.cempmobile.imaging.CempImagePackage
```

Add inside the `PackageList(this).packages.apply { ... }` block:

```kotlin
          add(CempImagePackage())
```

- [ ] **Step 5: Run the Kotlin compile gate**

Run: `cd apps/android/android && ./gradlew :app:compileDebugKotlin`
Expected: `BUILD SUCCESSFUL` — both imaging modules + package compile and register.

- [ ] **Step 6: Commit**

```bash
git add apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePickerModule.kt \
        apps/android/android/app/src/main/java/com/cempmobile/imaging/CempImagePackage.kt \
        apps/android/android/app/build.gradle \
        apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt
git commit -m "feat(android): CempImagePicker module + package registration + gradle deps"
```

---

## Task 10: `OutgoingTxJournalAdapter` (AttachmentChunkJournal)

**Files:**
- Create: `apps/android/src/outgoing-tx-journal.ts`
- Test: `apps/android/src/outgoing-tx-journal.test.ts`

**Interfaces:**
- Consumes: `OutgoingTransactionRepository` (`@cemp/database`) — methods `record`, `markState(txHash, state, {committedAtMs?})`, `findLatestByPurposePrefix`; `AttachmentChunkJournal` (`@cemp/images`).
- Produces: `class OutgoingTxJournalAdapter implements AttachmentChunkJournal` — consumed by Task 13.

- [ ] **Step 1: Write the failing test** (in-memory DB per `packages/cemp-database/src/repositories.test.ts`)

```ts
// apps/android/src/outgoing-tx-journal.test.ts
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NodeSqliteAdapter, OutgoingTransactionRepository, migrate } from "@cemp/database";
import type { SqliteAdapter } from "@cemp/database";
import { OutgoingTxJournalAdapter } from "./outgoing-tx-journal.js";

describe("OutgoingTxJournalAdapter", () => {
  let db: SqliteAdapter;
  let repo: OutgoingTransactionRepository;
  let journal: OutgoingTxJournalAdapter;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    repo = new OutgoingTransactionRepository(db);
    journal = new OutgoingTxJournalAdapter(repo);
  });
  afterEach(async () => { await db.close(); });

  it("records, marks state, and finds by purpose prefix", async () => {
    await journal.recordOutgoingTx({ txHash: "0xaa", purpose: "attachment-chunks:g1", state: "submitted" });
    await journal.markOutgoingTxState("0xaa", "committed", 1234);
    const found = await journal.findLatestOutgoingTxByPurposePrefix("attachment-chunks:");
    expect(found?.txHash).toBe("0xaa");
    expect(found?.state).toBe("committed");
  });

  it("returns undefined when no tx matches the prefix", async () => {
    expect(await journal.findLatestOutgoingTxByPurposePrefix("nope:")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && npx vitest run src/outgoing-tx-journal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/android/src/outgoing-tx-journal.ts
import type { OutgoingTransactionRepository } from "@cemp/database";
import type { AttachmentChunkJournal } from "@cemp/images";

/**
 * Adapts the app's OutgoingTransactionRepository to the AttachmentChunkJournal
 * the image chunk publisher expects (spec §2 step 4: chunk cells ride the same
 * journal as text). No new SQL — a shape bridge over existing methods.
 */
export class OutgoingTxJournalAdapter implements AttachmentChunkJournal {
  readonly #repo: OutgoingTransactionRepository;

  constructor(repo: OutgoingTransactionRepository) {
    this.#repo = repo;
  }

  async recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    submittedAtMs?: number | undefined;
    capacityShannon?: string | undefined;
    txHex?: string | undefined;
  }): Promise<void> {
    await this.#repo.record(input);
  }

  async markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void> {
    await this.#repo.markState(txHash, state, committedAtMs === undefined ? {} : { committedAtMs });
  }

  async findLatestOutgoingTxByPurposePrefix(
    prefix: string,
  ): Promise<{ txHash: string; state: string; purpose: string; txHex?: string | null } | undefined> {
    return await this.#repo.findLatestByPurposePrefix(prefix);
  }
}
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `cd apps/android && npx vitest run src/outgoing-tx-journal.test.ts`
Expected: PASS.

```bash
git add apps/android/src/outgoing-tx-journal.ts apps/android/src/outgoing-tx-journal.test.ts
git commit -m "feat(android): OutgoingTxJournalAdapter for attachment chunk publishing"
```

---

## Task 11: Thread `AttachmentRepository` into `SyncWorkerDeps`

**Files:**
- Modify: `packages/cemp-sync/src/workers.ts` (add `attachments` to `SyncWorkerDeps` + type import)
- Modify: `apps/android/src/messaging.ts` (construct `AttachmentRepository`, pass into `buildWorkerSpecs`)

**Interfaces:**
- Consumes: `AttachmentRepository` (`@cemp/database`).
- Produces: `SyncWorkerDeps.attachments: AttachmentRepository` — consumed by Task 12.

- [ ] **Step 1: Add the field to `SyncWorkerDeps`**

In `packages/cemp-sync/src/workers.ts`, add `AttachmentRepository` to the `type`-only import from `@cemp/database` (lines ~30-38), and add to the `SyncWorkerDeps` interface (after `outgoingTxs`):

```ts
  readonly attachments: AttachmentRepository;
```

- [ ] **Step 2: Construct + pass it in `messaging.ts`**

In `apps/android/src/messaging.ts` `init`, alongside the other repos (near `const outgoingTxs = new OutgoingTransactionRepository(db);`), add:

```ts
    const attachments = new AttachmentRepository(db);
```

Ensure `AttachmentRepository` is imported from `@cemp/database`. Add `attachments,` to the object passed to `buildWorkerSpecs({ ... })`.

- [ ] **Step 3: Verify the type suite compiles**

Run: `cd packages/cemp-sync && npx vitest run` and `cd apps/android && npx tsc --noEmit`
Expected: no type errors (a missing `attachments` field would fail here). Existing tests that build `SyncWorkerDeps` may need the new field — update their fixtures to pass a minimal `AttachmentRepository` (constructed over an in-memory DB, per Task 12's harness).

- [ ] **Step 4: Commit**

```bash
git add packages/cemp-sync/src/workers.ts apps/android/src/messaging.ts
git commit -m "feat(sync): thread AttachmentRepository into SyncWorkerDeps"
```

---

## Task 12: Persist the manifest on incoming image discovery

**Files:**
- Modify: `packages/cemp-sync/src/workers.ts` (`processDiscoveredCell`, after `messages.insert`)
- Test: `packages/cemp-sync/src/workers.test.ts` (add a case; reuse the file's existing deps harness)

**Interfaces:**
- Consumes: `incoming.attachmentManifests` (already returned by `processIncomingText`), `deps.attachments` (Task 11), `encodeAttachmentManifestV1` (`@cemp/core` `codec`).
- Produces: an `attachments` row (`kind: "image"`, encoded manifest blob) linked to the inserted message when the payload carries a manifest.

- [ ] **Step 1: Write the failing test** (a discovered 0x03 message persists an attachment row)

```ts
// packages/cemp-sync/src/workers.test.ts  (add this test)
import { describe, expect, it } from "vitest";
// Reuse this file's existing harness that builds SyncWorkerDeps over an
// in-memory NodeSqliteAdapter + migrate, and its helper to feed a decoded
// IncomingTextMessage into processDiscoveredCell.

describe("processDiscoveredCell image branch", () => {
  it("persists an image attachment row when the payload carries a manifest", async () => {
    const { deps, feedDiscovered, attachments, messages } = await makeWorkerHarness(); // existing/added helper
    const manifest = makeManifestV1({ mimeType: "image/webp", plaintextSize: 1000, width: 64, height: 48 });
    await feedDiscovered({
      contentType: 0x03,
      text: "",
      attachmentManifests: [manifest],
      // ...ids/keys the harness fills in...
    });
    const msg = (await messages.listByConversation(/* conv id from harness */ 1))[0];
    const rows = await attachments.listForMessage(msg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("image");
    expect(rows[0].manifest).not.toBeNull();
    expect(rows[0].byteLength).toBe(1000);
  });
});
```

> Implementer note: if `workers.test.ts` lacks a reusable harness that lets you inject a decoded incoming message, add `makeWorkerHarness()` there mirroring the existing worker test setup (in-memory DB + `migrate` + real repos incl. `AttachmentRepository`, a fake `CempClient`). Feed the decoded message directly into `processDiscoveredCell` (export it if not already, or drive via the discovery entry with a fake client returning the cell).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-sync && npx vitest run src/workers.test.ts`
Expected: FAIL — no attachment row persisted (branch not implemented).

- [ ] **Step 3: Write minimal implementation**

In `packages/cemp-sync/src/workers.ts`, import the codec:

```ts
import { codec } from "@cemp/core";
```

Immediately after the `const inserted = await deps.messages.insert({ ... });` call in `processDiscoveredCell`, add:

```ts
  // Image branch (design §3 step 1): an attachment message stores its manifest
  // (thumbnail embedded) so the bubble renders immediately with no fetch. The
  // full-res chunk download is deferred to a user tap (downloadAttachment).
  if (incoming.attachmentManifests.length > 0) {
    for (const manifest of incoming.attachmentManifests) {
      await deps.attachments.create({
        messageId: inserted.id,
        kind: "image",
        byteLength: Number(manifest.plaintext_size),
        manifest: codec.encodeAttachmentManifestV1(manifest),
      });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `cd packages/cemp-sync && npx vitest run src/workers.test.ts`
Expected: PASS.

```bash
git add packages/cemp-sync/src/workers.ts packages/cemp-sync/src/workers.test.ts
git commit -m "feat(sync): persist attachment manifest on incoming image discovery"
```

---

## Task 13: `MessagingService.publishImage` (send wiring + capacity pre-flight)

**Files:**
- Modify: `apps/android/src/messaging.ts` (add `publishImage`; construct journal adapter)
- Test: `apps/android/src/messaging.test.ts` (add a focused case, or a new `image-send.test.ts` if the service is hard to construct — see note)

**Interfaces:**
- Consumes: `publishImageMessage`, `estimateImageSendShannon`, `hasSufficientCapacity`, `CONSERVATIVE_PER_CHUNK_SHANNON`, `SEND_FEE_RESERVE_SHANNONS` (`@cemp/images`); `HandleTracker`, `NativeImageCodec` (`./platform/native-image-codec`); `OutgoingTxJournalAdapter` (`./outgoing-tx-journal`); `estimateAttachmentCapacity`, `prepareImage` for the count (or reuse the count from a dry prepare); `AttachmentRepository`; `randomBytes` from `@cemp/crypto`.
- Produces: `MessagingService.publishImage(input): Promise<{ messageTxHash: string }>` — consumed by Task 15.

- [ ] **Step 1: Write the failing test** (capacity pre-flight blocks an under-funded send before any publish)

```ts
// apps/android/src/messaging.test.ts  (add — or extract publishImage core into
// a testable free function `buildImageSend(deps,input)` if the full service is
// impractical to construct; the note below prefers extraction.)
import { describe, expect, it, vi } from "vitest";
import { runImageSend } from "./image-send.js"; // extracted core (see Step 3)

describe("runImageSend capacity pre-flight (5A)", () => {
  it("throws a jargon-free error and never publishes when the wallet can't cover it", async () => {
    const publish = vi.fn();
    await expect(
      runImageSend(
        {
          codec: fakeTrackedCodec(), // wraps FakeCodec in a HandleTracker-like stub
          preparedChunkCount: 16,
          availableShannon: 100n, // far too little
          perChunkShannon: 33_000n * 100_000_000n,
          messageCellShannon: 20_000n * 100_000_000n,
          publish,
        },
        { /* input */ } as never,
      ),
    ).rejects.toThrow(/not enough balance/i);
    expect(publish).not.toHaveBeenCalled();
  });
});
```

> Implementer note (strong recommendation): extract the send orchestration into a free function `runImageSend(deps, input)` in `apps/android/src/image-send.ts` (deps = codec/tracker, capacity inputs, a `publish` callback delegating to `publishImageMessage`, an `attachments` repo, `prepareImage` for the pre-flight count). `MessagingService.publishImage` is then a thin wiring shim that assembles real deps. This keeps the capacity logic and error handling unit-testable without constructing the whole service. Put the `ImageTooLargeError` -> jargon-free mapping and the capacity gate here.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && npx vitest run src/messaging.test.ts`
Expected: FAIL — `runImageSend` / `image-send.ts` not defined.

- [ ] **Step 3: Write minimal implementation**

Create `apps/android/src/image-send.ts` with `runImageSend` implementing: (1) `prepareImage(codec, bytes)` to learn the chunk count (or call `estimateAttachmentCapacity` on a dry `prepareImage`); catch `ImageTooLargeError` → `throw new Error("This photo's too large to send. Try a smaller one.")`; (2) capacity pre-flight via `estimateImageSendShannon` + `hasSufficientCapacity`; on insufficient → `throw new Error("Not enough balance to send this image.")` BEFORE any publish; (3) on OK, call the injected `publish` (which wraps `publishImageMessage` with a fresh `HandleTracker`, releasing in `finally`); (4) persist the local outgoing attachment row via `attachments.create({ messageId, kind: "image", byteLength, manifest: encodeAttachmentManifestV1(result.manifest) })`.

Then add `MessagingService.publishImage` in `apps/android/src/messaging.ts`:

```ts
  async publishImage(input: {
    messageRowId: number;
    logicalMessageId: string;
    recipientProfileIdHex: string;
    recipientKemPublicKey: Uint8Array;
    recipientProfileId: Uint8Array;
    sourceBytes: Uint8Array;
    caption?: string;
  }): Promise<{ messageTxHash: string }> {
    const tracker = new HandleTracker(new NativeImageCodec());
    try {
      const journal = new OutgoingTxJournalAdapter(this.#outgoingTxs);
      const balance = await this.#balances.getSpendableShannon(this.#walletId); // existing accessor
      const result = await runImageSend(
        {
          codec: tracker,
          publish: (manifestInput) =>
            publishImageMessage(
              {
                codec: tracker,
                client: this.#client, signer: this.#signer,
                messageType: this.#messageType, journal,
                publisher: this.#publisher,
                senderProfileId: this.#senderProfileId, senderDeviceId: this.#senderDeviceId,
                randomBytes,
              },
              manifestInput,
            ),
          attachments: this.#attachments,
          availableShannon: balance,
          perChunkShannon: CONSERVATIVE_PER_CHUNK_SHANNON,
          messageCellShannon: CONSERVATIVE_MESSAGE_CELL_SHANNON,
          feeReserveShannon: SEND_FEE_RESERVE_SHANNONS,
        },
        input,
      );
      return { messageTxHash: result.messageTxHash };
    } finally {
      await tracker.releaseAll();
    }
  }
```

> Wiring details for the implementer: add `#messageType`, `#senderProfileId`, `#senderDeviceId`, `#attachments` as fields if not already present (they are already wired into the publisher/workers at construction — reuse those values). Confirm the exact spendable-balance accessor on `BalanceRepository` (the earlier balance code uses `getLockBalance`/`getSpendableShannon`-style methods — use the one already used by the text send affordability check) and define `CONSERVATIVE_MESSAGE_CELL_SHANNON` next to the capacity constants (a message cell is bounded and small; a ~20,000-CKB upper bound is safe).

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `cd apps/android && npx vitest run src/messaging.test.ts src/image-send.test.ts`
Expected: PASS.

```bash
git add apps/android/src/image-send.ts apps/android/src/messaging.ts apps/android/src/messaging.test.ts apps/android/src/image-send.test.ts
git commit -m "feat(android): MessagingService.publishImage with capacity pre-flight (5A)"
```

---

## Task 14: `imageBubbleState` view-model (download state machine)

**Files:**
- Create: `packages/cemp-ui/src/image-bubble.ts`
- Test: `packages/cemp-ui/src/image-bubble.test.ts`
- Modify: `packages/cemp-ui/src/index.ts` (export)

**Interfaces:**
- Produces: `type ImageDownloadState`, `imageBubbleState(input): ImageBubblePresentation` — consumed by Task 15.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cemp-ui/src/image-bubble.test.ts
import { describe, expect, it } from "vitest";
import { imageBubbleState } from "./image-bubble.js";

describe("imageBubbleState", () => {
  it("shows the thumbnail with a load affordance before download", () => {
    const s = imageBubbleState({ hasThumbnail: true, download: "idle" });
    expect(s).toEqual({ showThumbnail: true, showFull: false, affordance: "tap-to-load", showSpinner: false });
  });
  it("spins while downloading", () => {
    expect(imageBubbleState({ hasThumbnail: true, download: "loading" }))
      .toEqual({ showThumbnail: true, showFull: false, affordance: "none", showSpinner: true });
  });
  it("keeps the thumbnail and offers retry on failure (7A)", () => {
    expect(imageBubbleState({ hasThumbnail: true, download: "error" }))
      .toEqual({ showThumbnail: true, showFull: false, affordance: "tap-to-retry", showSpinner: false });
  });
  it("shows the full image once loaded", () => {
    expect(imageBubbleState({ hasThumbnail: true, download: "loaded" }))
      .toEqual({ showThumbnail: false, showFull: true, affordance: "none", showSpinner: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cemp-ui && npx vitest run src/image-bubble.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cemp-ui/src/image-bubble.ts
/** Download lifecycle for a received image (design §3 + spec §4 item 7 / 7A). */
export type ImageDownloadState = "idle" | "loading" | "loaded" | "error";

export interface ImageBubblePresentation {
  readonly showThumbnail: boolean;
  readonly showFull: boolean;
  readonly affordance: "tap-to-load" | "tap-to-retry" | "none";
  readonly showSpinner: boolean;
}

export function imageBubbleState(input: {
  readonly hasThumbnail: boolean;
  readonly download: ImageDownloadState;
}): ImageBubblePresentation {
  switch (input.download) {
    case "idle":
      return { showThumbnail: input.hasThumbnail, showFull: false, affordance: "tap-to-load", showSpinner: false };
    case "loading":
      return { showThumbnail: input.hasThumbnail, showFull: false, affordance: "none", showSpinner: true };
    case "error":
      // 7A: thumbnail never leaves the manifest cell, so keep it + offer retry.
      return { showThumbnail: input.hasThumbnail, showFull: false, affordance: "tap-to-retry", showSpinner: false };
    case "loaded":
      return { showThumbnail: false, showFull: true, affordance: "none", showSpinner: false };
  }
}
```

Add to `packages/cemp-ui/src/index.ts`: `export * from "./image-bubble.js";`

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `cd packages/cemp-ui && npx vitest run src/image-bubble.test.ts`
Expected: PASS.

```bash
git add packages/cemp-ui/src/image-bubble.ts packages/cemp-ui/src/image-bubble.test.ts packages/cemp-ui/src/index.ts
git commit -m "feat(ui): imageBubbleState download state machine (7A retry)"
```

---

## Task 15: Chat screen — attach button, image send, image bubble + tap-to-download

**Files:**
- Modify: `apps/android/src/screens/chat-screen.tsx`

**Interfaces:**
- Consumes: `pickImage` (Task 7), `MessagingService.publishImage` (Task 13), `imageBubbleState` (Task 14), `AttachmentRepository.listForMessage` + `decodeAttachmentManifestV1` + `downloadAttachment` (`@cemp/images`/`@cemp/core`).
- Produces: UI. Verified by Task 17 on-device (RN screen has no unit harness here — keep logic in the tested view-model/service; the screen is thin glue).

- [ ] **Step 1: Add the attach button + image send handler**

In the composer `View` (beside the `Send` `Button`), add an attach button that runs:

```tsx
  async function attachImage(): Promise<void> {
    setPublishError(null);
    try {
      const bytes = await pickImage();
      if (bytes === null) return; // cancel = no-op (spec §4 item 2)
      const row = await composer.insertImageDraft(); // inserts an outgoing image message row (body null)
      if (container.hasMessaging && contact?.profileIdHex != null) {
        await container.messaging.publishImage({
          messageRowId: row.id,
          logicalMessageId: row.logicalMessageId,
          recipientProfileIdHex: contact.profileIdHex,
          recipientKemPublicKey: contact.kemPublicKey,   // resolved on the contact
          recipientProfileId: hexToBytes(strip0x(contact.profileIdHex)),
          sourceBytes: bytes,
        });
      }
    } catch (e) {
      // ImageTooLargeError / decode / capacity all arrive here already jargon-free.
      setPublishError(e instanceof Error ? e.message : "Couldn't send that image.");
    }
    await reload();
  }
```

> Implementer note: `composer.insertImageDraft()` is a small addition to `ChatComposerViewModel` (mirror `send()`'s insert but with `body: null`; reuse the `logicalMessageId` generation). If the contact record doesn't already carry `kemPublicKey`, resolve it the same way the text publish path resolves the recipient profile (the publisher already calls `resolveLiveProfile`; expose the resolved KEM key or resolve once here).

- [ ] **Step 2: Branch `renderItem` on whether the message has an image attachment**

Load attachments for the conversation in `reload()` (a `Map<messageId, Attachment>` via `attachments.listForMessage`), then in `renderItem`:

```tsx
          const attachment = attachmentsByMessage.get(item.id);
          if (attachment?.kind === "image") {
            return (
              <ImageBubble
                outgoing={item.direction === "outgoing"}
                manifest={decodeAttachmentManifestV1(attachment.manifest!)}
                downloadState={downloadStates.get(item.id) ?? "idle"}
                onTap={() => void loadFull(item.id, attachment)}
              />
            );
          }
          // ...existing text bubble...
```

Where `ImageBubble` is a small inline component using `imageBubbleState(...)` to decide thumbnail (`manifest.thumbnail` as a data URI) vs full image vs spinner vs retry label.

- [ ] **Step 3: Implement `loadFull` (tap-to-download, 7A)**

```tsx
  async function loadFull(messageId: number, attachment: Attachment): Promise<void> {
    setDownloadState(messageId, "loading");
    try {
      const manifest = decodeAttachmentManifestV1(attachment.manifest!);
      const attachmentKey = await container.messaging.deriveIncomingAttachmentKey(messageId); // from stored envelope
      const full = await downloadAttachment(container.client, manifest, attachmentKey);
      setFullImage(messageId, full.bytes, full.mimeType);
      setDownloadState(messageId, "loaded");
    } catch {
      setDownloadState(messageId, "error"); // keep thumbnail, offer retry
    }
  }
```

> Implementer note: the incoming `attachmentKey` is derived from the stored envelope on decrypt (`decryptEnvelope` returns it). The sync worker already has it at discovery time; the cleanest path is to persist the per-message attachment key alongside the attachment row (or re-derive from the stored envelope + own KEM secret key on demand via a `MessagingService.deriveIncomingAttachmentKey`). Add that accessor; it wraps `decryptEnvelope` over the stored message cell using `ownKemSecretKey`. Wipe the key after `downloadAttachment`.

- [ ] **Step 4: Manual verification (no RN unit harness here)**

Run: `cd apps/android && npx tsc --noEmit` — screen compiles against the real types.
Full behavioural verification is the on-device round-trip (Task 17).

- [ ] **Step 5: Commit**

```bash
git add apps/android/src/screens/chat-screen.tsx apps/android/src/... # composer/container additions
git commit -m "feat(android): chat image UI — attach, image bubble, tap-to-download (7A)"
```

---

## Task 16: Full suite + type + Kotlin compile gate

**Files:** none (verification task).

- [ ] **Step 1: Run all affected package test suites**

Run:
```bash
cd packages/cemp-crypto && npx vitest run
cd packages/cemp-ckb && npx vitest run
cd packages/cemp-images && npx vitest run
cd packages/cemp-sync && npx vitest run
cd packages/cemp-ui && npx vitest run
cd apps/android && npx vitest run
```
Expected: all green.

- [ ] **Step 2: Typecheck the app and packages**

Run: `cd apps/android && npx tsc --noEmit` (and each modified package's `tsc --noEmit` if not covered by a root task).
Expected: no type errors.

- [ ] **Step 3: Kotlin compile + debug APK**

Run: `cd apps/android/android && ./gradlew :app:compileDebugKotlin && ./gradlew :app:assembleDebug`
Expected: `BUILD SUCCESSFUL`; a debug APK is produced.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "chore: green suite + kotlin compile + debug APK for image messaging"
```

---

## Task 17: On-device round-trip + metadata-strip proof (5A ground truth)

**Files:** none (manual, device verification — the ground-truth gate per spec §5).

- [ ] **Step 1: Fund the Samsung**

Confirm the Samsung wallet has enough testnet CKB for a chunk-heavy send (a 512 KB image ≈ 16 chunks ≈ ~525k CKB). Faucet top-up if needed. The Retroid stays receive-only (~4,512 CKB).

- [ ] **Step 2: Install the debug APK on both devices**

Run: `cd apps/android/android && ./gradlew :app:installDebug` (per device via `adb -s <serial>`).

- [ ] **Step 3: Send an image Samsung → Retroid**

Pick a photo WITH EXIF/GPS on the Samsung, send to the Retroid contact. Confirm: outgoing bubble shows the local thumbnail + `queued → sent`; chunk tx then message tx commit on testnet (note both tx hashes).

- [ ] **Step 4: Receive + render on the Retroid**

Confirm the Retroid shows the thumbnail immediately (no fetch), a generic notification (no content leak), then tap → spinner → full-res renders. Content-hash + mime-sniff pass inside `downloadAttachment` (a failure would surface as tap-to-retry).

- [ ] **Step 5: Prove metadata stripping (5A)**

Pull the rendered full-res image off the Retroid (`adb pull` from the app cache, or export) and run an EXIF check:
```bash
exiftool received-image.webp | grep -iE "gps|orientation|make|model" || echo "no EXIF/GPS — PASS"
```
Expected: no GPS/EXIF tags; orientation correct (baked into pixels).

- [ ] **Step 6: Confirm reclaim after ack**

After the Retroid auto-acks, confirm the Samsung reclaims the chunk cells (existing `reclaimAttachmentGroup` path) — capacity returns to the sender.

- [ ] **Step 7: Record the result**

Log the e2e (tx hashes, EXIF-strip PASS, capacity reclaimed) in the session notes / test log, mirroring the 2026-07-23 text e2e entry.

---

## Self-Review

Run after implementing. Confirms plan ↔ spec coverage:

- **§1 Architecture:** Tasks 6–9 (native codec/picker + adapters), 13/15 (wiring/UI). ✓
- **§2 Send flow:** Tasks 4 (orchestration), 13 (publishImage), 15 (composer). ✓
- **§3 Receive flow:** Tasks 12 (persist manifest), 14/15 (thumbnail + tap-to-download). ✓
- **§4 Error handling:** too-large/decode/capacity (Tasks 5, 13), handle release-on-error (Task 6), 7A retry (Tasks 14/15), malformed-message safety (Task 12 guards on `attachmentManifests.length`). ✓
- **§5 Testing:** JS-adapter tests (6, 7, 10), compile gate (9, 16), on-device + EXIF proof (17). ✓
- **§6 Key coordination:** Tasks 1 (deriveSendAttachmentKey), 2/3 (override threading), 4 (orchestration + coordination round-trip test). ✓
