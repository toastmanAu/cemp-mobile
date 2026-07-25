# Android image messaging (send + receive round-trip) — design

**Status:** COMPLETE DRAFT — sections 1–5 approved 2026-07-24; Section 6 (attachment-key
coordination, C-on-A) added + approved 2026-07-25 after tracing revealed a missing send-side
seam. Next: writing-plans → implementation plan.

## Goal

Wire the completed `@cemp/images` backend into the Android app for a full image
**round-trip** — pick → send on-chain → receive → render — proven on testnet across
both devices (like the 2026-07-23 text e2e). This is Phase 10 completion in the UI.

Context that reframed the task: `@cemp/images` is done and tested, but **only against
a mock codec** — there is NO real `ImageCodec` implementation anywhere. So this is a
real feature (native codec + picker + send + receive + render), not just UI wiring.

## Decisions (all confirmed with user)

1. **Scope:** full round-trip (send AND receive/render), proven on testnet. (chose A)
2. **Codec:** native Kotlin `ImageCodec` module (Android `Bitmap`), NOT an off-the-shelf
   RN library — matches the `CempKdf` pattern, guarantees metadata stripping by
   construction, preserves the exact `decode/resize/encode` seam. (chose A)
3. **Received-image UX:** thumbnail-immediate (embedded in the manifest cell, no fetch)
   + tap-to-download the full-res chunks. NOT auto-download. Matches the manifest /
   pre-download-bomb-guard design. (chose A)
4. **Picker:** native Kotlin module wrapping Android's system Photo Picker
   (`ACTION_PICK_IMAGES`, no storage permission on 13+), NOT `react-native-image-picker`
   — no new dependency, matches the "several small native modules" pattern. (chose A)

Constraint (test phase, not design): image sends cost more CKB than text (multiple
chunk cells) → test the send from the Samsung (better funded); may need a faucet top-up.
The Retroid is capacity-bound (~4,512 CKB available).

## Section 1 — Architecture & components (APPROVED)

The platform-neutral `@cemp/images` pipeline (compress policy, encryption, chunking,
manifests) stays untouched. We add the two missing platform seams + UI/wiring.

New native Kotlin modules (same pattern as `CempKdf`/`CempScheduler`/`CempNotifier`):
- **`CempImageCodec`** — implements the `ImageCodec` seam via a `Bitmap` handle-registry
  (the pipeline does `decode → resize ×2 → encode`, so the native side holds bitmaps
  keyed by an int handle passed to JS):
  - `decode(bytes)` → `BitmapFactory.decodeByteArray` + apply `ExifInterface` orientation
    via a matrix — **bakes orientation into pixels and drops all EXIF/GPS** (the security
    guarantee, for free) → `{handle, w, h}`
  - `resize(handle, w, h)` → `createScaledBitmap` → new handle
  - `encode(handle, format, quality)` → `Bitmap.compress(JPEG|WEBP)` → bytes
  - `release(handle)` → recycle; a thin JS adapter tracks handles created during one
    `prepareImage` and releases them at the end (the `ImageCodec` interface has no
    release, so the adapter owns lifecycle)
- **`CempImagePicker`** — launches the system Photo Picker, returns selected image bytes.

JS adapters (in `apps/android/src/platform/`): wrap each native module to the exact TS
interface (`ImageCodec`, and `pickImage(): Promise<Uint8Array | null>`).

Wiring: `messaging.ts` gains an image send path; `chat-screen.tsx` gets an attach button
+ preview; the `bubble` view-model + chat screen render image bubbles (thumbnail → tap →
full).

Open impl detail (for the plan, not blocking): byte marshalling across the New-Arch
bridge — base64 strings (simple, matches CempKdf precedent) vs ArrayBuffer (JSI, less
copy). Images are ≤1 MB so either works; decide in the plan.

## Section 2 — Send flow (APPROVED)

1. **Pick** — `CempImagePicker` returns raw image bytes (any size/format).
2. **Prepare** — `prepareImage(codec, bytes, limits)`: decode (orientation baked, metadata
   stripped) → compress to policy (dimension→quality retreat, hard-fail >1 MB via
   `ImageTooLargeError`) → compressed main image + embedded thumbnail.
3. **Chunk + manifest** — `prepareAttachmentChunks(...)`: encrypt under the
   envelope-derived attachment key, split into 32 KiB chunks, `buildAttachmentManifest`
   (thumbnail + cipher hash + content hash + chunk count + mime).
4. **Publish** — `publishAttachmentChunks(...)`: one batched, journaled, crash-resumable
   transaction (chunk cells + message cell carrying the manifest), riding the SAME
   outgoing state machine + pre-broadcast journal as text — so `runPendingTransactions`
   / reclaim already cover it.
5. **UI** — composer shows the local thumbnail immediately in an outgoing bubble with the
   normal `queued → sent` states.

Only genuinely new send code = pick → prepare (the codec). Steps 3–5 reuse existing
publish/journal/state-machine machinery.

## Section 3 — Receive & render flow (APPROVED)

1. **Discovery** — the existing sync worker finds the message cell; an image message's
   cell carries the manifest (with thumbnail) instead of a text body. Stored as an
   incoming "image" message, advanced to `received`, notified with the unchanged generic
   copy (no content leak).
2. **Bubble** — render the embedded thumbnail immediately (already in the manifest cell,
   no network fetch) with a "tap to load" affordance.
3. **Tap → download** — `downloadAttachment(...)`: pull chunk cells, `checkManifest`
   (pre-download bomb guard on declared size/count), decrypt, verify content hash,
   `sniffImageFormat` on the plaintext (untrusted mime), display full-res.
4. **Reclaim** — sender's chunk cells reclaim via the existing `reclaimAttachmentGroup`
   path after ack, same as text.

Receive reuses discovery + reclaim wholesale; new code = the message-kind branch
(text vs image manifest), thumbnail rendering, tap-to-download handler.

## Section 4 — Error handling (APPROVED)

The `@cemp/images` receive pipeline is already fully defensive — `downloadAttachment`
throws on every failure (bomb-guard via `checkManifest`, chunk-not-live, oversized chunk,
ciphertext/plaintext hash mismatch, sniff-vs-declared-mime mismatch). So receive-side
handling is purely a UX question; the genuinely new error handling is on the send side
(new native codec + picker).

**Send side (new code → new handling):**

1. **Image too large** — `ImageTooLargeError` from `compressToLimits` (dimension→quality
   retreat exhausted, still >1 MB). Expected, not a crash: caught at the composer, surfaced
   jargon-free (rule 15) — *"This photo's too large to send. Try a smaller one."* No stranded
   outgoing row — we fail before any tx is built.
2. **Picker cancel** — user dismisses the Photo Picker → adapter resolves `null` → pure
   no-op (no bubble, no error).
3. **Decode failure** — corrupt/unsupported bytes → `BitmapFactory.decodeByteArray` returns
   null → native `decode` throws → adapter surfaces *"Couldn't read that image."* Composer
   stays put.
4. **Handle-registry leak safety** — the JS codec adapter wraps `prepareImage` in
   `try/finally` and `release()`s every bitmap handle it created, including on the
   decode/resize/encode throw path; native side recycles defensively too. This is the one
   memory-correctness invariant unique to the handle-registry seam.
5. **Insufficient CKB (chunk-heavy send) — DECISION 5A (pre-flight, defer adaptive):**
   compress to the fixed protocol budget, then pre-flight a capacity estimate
   (`chunks × per-chunk CKB + fee`) BEFORE building the tx and block with a jargon-free
   message if the wallet can't cover it. Fails fast → no stranded pending row, no confusing
   partial-send.

   Reuse: `@cemp/images` already exports `estimateAttachmentCapacity(prepared, chunkBytes)`
   → `{encryptedBytes, chunkCount}` (the byte/chunk-count half). The pre-flight layers the
   per-chunk cell capacity (~1 CKB/byte + cell overhead) + fee on top of `chunkCount` and
   compares to the wallet balance — do NOT re-derive the chunk math.

   Rationale/context: on-chain storage is ~1 CKB per byte, so an image send locks roughly
   its own byte-size in CKB (a 32 KiB chunk cell ≈ ~32,800 CKB; a 512 KB image ≈ 16 chunks
   ≈ ~525k CKB; 1 MB ≈ 32 chunks). Capacity — not the 1 MB cap — is the dominant cost, and
   why the capacity-bound Retroid (~4,512 CKB) can only RECEIVE, and the test send comes
   from the better-funded Samsung.

   **Deferred future lever (NOT this milestone):** `compressToLimits` and `checkManifest`
   both take an injectable `ImageLimits`, so a capacity-ADAPTIVE send (derive a tighter
   byte budget from available balance and feed it to the retreat ladder so it auto-fits the
   wallet) is buildable with no pipeline change. Deferred because it adds a UX question
   (silently degrade quality vs. tell the user) + estimation-accuracy risk beyond the
   round-trip proof. The seam is ready when we want it.
6. **Publish crash mid-send** — no new handling; rides the existing pre-broadcast journal +
   `runPendingTransactions` + reclaim, identical to text.

**Retry (post-milestone follow-up, decided 2026-07-25):**

9. **Send retry — DECISION 9A (tap-to-retry, re-pick for images):** any send failure lands
   the row in `failed` (fix I-1), and the failed bubble's *"failed — tap retry"* affordance
   republishes on the SAME row/logical id (`failed → queued` requeue edge; a retry may mint
   a new tx hash but stays the same message in the local UI). Text republishes its persisted
   body; an image re-opens the picker, because its compressed plaintext bytes are never
   persisted (rule 3) and re-picking is the only honest retry for the dominant failure modes
   anyway (too-large / capacity). Persisting compressed bytes for picker-free retry was
   rejected for this milestone: it requires an encrypted-blob store + schema migration, and
   `failed → queued` is only ever a PRE-commit edge — a failure after commit belongs to the
   journal/reclaim lifecycle (item 6).

**Receive side (pipeline already throws → UX only):**

7. **Any `downloadAttachment` throw — DECISION 7A (keep thumbnail + tap-to-retry):** the
   thumbnail is always safe (it never left the manifest cell), so on any thrown error keep
   the thumbnail visible and swap the affordance to *"Couldn't load full image — tap to
   retry."* Download is idempotent and the common failure (chunk not yet indexed) is
   transient, so retry is the honest default. A reclaimed/pruned chunk (`not live`) also
   lands here — retry keeps failing gracefully, which is acceptable.
8. **Malformed image message at discovery** — a message whose payload claims an attachment
   but fails manifest decode is logged and stored as a normal received message with no
   image bubble; never crashes the sync worker.

## Section 5 — Testing & on-device verification (APPROVED)

Layered cheapest → ground-truth. The app has no instrumented (`androidTest`) harness today;
its established automated layer is vitest JS-adapter tests (`src/platform/*.test.ts`) plus
the Kotlin compile gate. Native modules have never had JVM/Kotlin unit tests, and we keep
that precedent.

1. **JS adapter unit tests** (vitest, matching `src/platform/*.test.ts`):
   - **Codec adapter** — handle lifecycle + the release-on-error invariant (fake native
     bridge that throws inside `encode`; assert the `try/finally` released every handle
     created during `prepareImage`); byte-marshalling round-trip.
   - **Picker adapter** — resolves `null` on cancel, bytes on pick.
2. **Pipeline coverage — reuse, don't duplicate.** `packages/cemp-images/src/images.test.ts`
   already drives the full `prepare → chunk → manifest → receive` round-trip against the
   deterministic mock codec. We're wiring, not changing the pipeline — so no new pipeline
   tests, only a shape/conformance check that the real adapter satisfies the exact
   `ImageCodec` TS interface the mock does.
3. **Kotlin compile gate** — `compileDebugKotlin` stays green (the cheap CI gate proving the
   two native modules build). No JVM Kotlin unit tests (matching precedent).
4. **Metadata-stripping proof — DECISION 5A (on-device, defer instrumented):** the security
   guarantee (EXIF/GPS never crosses decode→encode; orientation baked into pixels) needs the
   real codec, so it is asserted ON-DEVICE during the e2e — pull the received full-res image,
   run an EXIF check, confirm no EXIF/GPS and correct baked orientation. No new infra;
   matches the "on-device is ground truth" lesson.

   **Deferred alternative (5B, NOT this milestone):** the app's first instrumented
   (`androidTest`) test — decode a known GPS-laden JPEG through the real `CempImageCodec`,
   re-parse the output, assert no EXIF — for a permanent CI guarantee. Deferred to avoid
   standing up (and maintaining) a new harness for the round-trip milestone.
5. **On-device round-trip (ground truth)** — Samsung→Retroid, mirroring the 2026-07-23 text
   e2e: send the image from the Samsung → Retroid shows the thumbnail immediately →
   tap-download renders full-res with content-hash verified → sender reclaims chunk cells
   after ack. Capacity: fund the Samsung (faucet top-up if a chunk-heavy send needs it);
   Retroid stays receive-only (~4,512 CKB, cannot fund a send).

## Section 6 — Outgoing attachment-key coordination (APPROVED — added 2026-07-25)

**Why this section exists:** the spec originally framed the work as "wire the *completed*
`@cemp/images` backend." Tracing the send path showed the backend is complete on the
receive side but has a MISSING SEAM on the send side that was never exercised end-to-end
(the package's own e2e test hard-codes `new Uint8Array(32).fill(11)` as the attachment key
on both sides, so it never derives a real one).

**The chicken-and-egg.** Attachment chunks are AES-encrypted under a 32-byte `attachmentKey`
derived from the message envelope's ML-KEM shared secret
(`deriveMessageKey(sharedSecret, nonce, senderProfileId, recipientProfileId,
"CEMP-ATTACHMENT-KEY-V1")` — spec §9.2, no key material is transported; the recipient
re-derives it in `decryptEnvelope`). But chunks must be encrypted and published BEFORE the
message tx (the manifest needs their outpoints), while the key is produced INSIDE
`assembleTextMessage`/`encryptEnvelope`, which do a fresh random ML-KEM encapsulation on
every call. Publish chunks under key A, then let the message do its own encapsulation → the
recipient derives key B ≠ A → every `downloadAttachment` fails its hash check.

**Decision: C-on-A** (chosen with user 2026-07-25).

- **A — thread one shared encapsulation (crypto seam):** `encryptEnvelope` already accepts
  `kemMessage` (32-byte FIPS-203 encapsulation message) + `nonce` overrides — currently
  labelled test-only. Fixing both makes the encapsulation deterministic, so the sender can
  derive `attachmentKey` up front and later seal the message under the SAME encapsulation.
  - New tested helper in `@cemp/crypto`: `deriveSendAttachmentKey({ recipientKemPublicKey,
    kemMessage, nonce, senderProfileId, recipientProfileId }) → Uint8Array` — encapsulate
    with the given `kemMessage`, then `deriveMessageKey(sharedSecret, nonce, sender,
    recipient, "CEMP-ATTACHMENT-KEY-V1")`.
  - Thread an optional `attachmentEnvelope?: { kemMessage; nonce }` through
    `AssembleTextMessageParams` → `PublishTextInput`, forwarded to `encryptEnvelope`'s
    overrides. Documented as a REAL production seam (not "test override").
  - **SAFETY INVARIANT (non-negotiable):** the override warning is about *reuse*. C-on-A is
    sound ONLY because the orchestration generates FRESH CSPRNG `kemMessage`+`nonce` per
    message and uses them for exactly one published envelope. The seam is shaped so the app
    never hand-supplies these — the orchestration owns their generation. Reusing a
    `(kemMessage, nonce)` pair across two envelopes breaks per-envelope key uniqueness and
    is forbidden.
- **C — orchestration home:** a new `publishImageMessage(deps, input)` in `@cemp/images`
  (which already depends on `@cemp/ckb`; the reverse dependency would be a cycle, so this
  canNOT live in the publisher). It: (1) generates fresh `kemMessage`+`nonce`, (2)
  `deriveSendAttachmentKey`, (3) `prepareAttachmentChunks` + `publishAttachmentChunks` under
  that key, (4) `buildManifestForCommittedChunks`, (5) publishes the `0x03` manifest-carrying
  message via the injected `MessagePublisher.publishText({ contentType: 0x03,
  attachmentManifests: [manifest], attachmentEnvelope: { kemMessage, nonce } })` — reusing
  publishText's journal / monitor / crash-resume wholesale. The app's
  `MessagingService.publishImage` just calls it with the native codec + app deps.

This keeps `publishText` (text path) untouched, reuses the proven publish machinery, adds no
new molecule/tx code, and confines the new crypto surface to one tested helper + one
documented, safety-constrained override seam. On-device round-trip (Section 5) is the
ground-truth proof that the two sides derive byte-identical keys.

## Resume checklist

- [x] Finish Section 4 (error handling) — approved (5A pre-flight capacity; 7A keep-thumbnail+retry)
- [x] Finish Section 5 (testing) — approved (5A on-device metadata proof; instrumented deferred)
- [x] Spec self-review (placeholders/consistency/scope/ambiguity), fix inline
- [x] User reviews finalized spec — approved 2026-07-24
- [x] Section 6 added (attachment-key coordination, C-on-A) — approved 2026-07-25
- [x] Invoke writing-plans skill → implementation plan — `docs/superpowers/plans/2026-07-25-android-image-messaging.md` (2026-07-25)
