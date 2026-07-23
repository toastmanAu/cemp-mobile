# Android image messaging (send + receive round-trip) — design

**Status:** DRAFT / in-progress (brainstorming paused 2026-07-24 to resume). Sections
1–3 approved by user; error-handling + testing sections still to write; then finalize
+ user spec review + writing-plans.

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

## Section 4 — Error handling (TODO — not yet written)

To cover next session: `ImageTooLargeError` surfaced in the composer (jargon-free, rule
15); picker cancel = no-op; decode failure on a corrupt pick; download failure / manifest
mismatch / bomb-guard rejection on receive; bitmap handle-registry leak safety (release on
error paths); capacity/insufficient-CKB on a chunk-heavy send.

## Section 5 — Testing & on-device verification (TODO — not yet written)

To cover next session: unit tests for the JS adapters against the existing image test
vectors; codec metadata-stripping assertion (decode→encode carries no EXIF); native module
compile gate (`compileDebugKotlin`); on-device round-trip Samsung→Retroid mirroring the
text e2e (send image from Samsung, thumbnail + tap-download on Retroid); wallet capacity
note.

## Resume checklist

- [ ] Finish Section 4 (error handling) — present, get approval
- [ ] Finish Section 5 (testing) — present, get approval
- [ ] Spec self-review (placeholders/consistency/scope/ambiguity), fix inline
- [ ] User reviews finalized spec
- [ ] Invoke writing-plans skill → implementation plan
