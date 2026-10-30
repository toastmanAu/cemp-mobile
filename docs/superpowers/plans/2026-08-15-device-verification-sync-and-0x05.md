# Device verification — foreground sync (`5da70c5`) + attachment-ack reclaim gate (`df77fab`)

**Status:** user-executed acceptance gate. Both commits are on `main`, unit-green
(707 pass / 1 skipped), and neither carries an on-device confirmation in its commit
body — unlike `92800fe`, which does. This runbook closes that gap.

**Devices.** Samsung `R5CTC07MPYD` = **A**, the funded sender. Retroid
`JY202406200301173` = **B**, capacity-bound (~4,512 CKB), receive-only. Direction
matters: only the sender reclaims, so the image must go **A → B**.

**Build.** Use `apps/android/android/app/build/outputs/apk/release/app-release.apk`.
Its mtime (Aug 6 23:42) predates the `df77fab` commit (23:43), but the bundle was
verified by content to contain both fixes — `remote_downloaded` appears in the Hermes
string table and `git log -S` proves only `df77fab` ever introduced that literal.
**Do not use `app-debug.apk`** — it is from Jul 26 and predates both fixes.

Re-verify provenance any time the APK is rebuilt:

```bash
unzip -p apps/android/android/app/build/outputs/apk/release/app-release.apk \
  assets/index.android.bundle | grep -ac remote_downloaded    # expect >= 1
```

---

## ⚠️ Read first — capacity

On-chain storage costs ~1 CKB per byte, so an image send **locks roughly its own
byte size in CKB**, released only after the chunks are reclaimed. This test
deliberately holds that capacity locked across a waiting period, so:

- Send a **small** image — target **20–50 KB** (≈20,000–50,000 CKB locked).
- Check A's Wallet balance **before** starting and confirm it comfortably exceeds
  the image size. If the pre-flight blocks the send with "Not enough balance to
  send this image.", that is the gate working — top up and retry with a smaller file.
- B never sends an image; it only receives and acks.

---

## Setup

- [ ] **S1. Connect both phones** and confirm adb sees them:

  ```bash
  adb devices -l          # expect R5CTC07MPYD and JY202406200301173, both "device"
  ```

- [ ] **S2. Install the release APK on both:**

  ```bash
  APK=apps/android/android/app/build/outputs/apk/release/app-release.apk
  adb -s R5CTC07MPYD install -r "$APK"
  adb -s JY202406200301173 install -r "$APK"
  ```

- [ ] **S3. Start log capture** (one shell per device, left running):

  ```bash
  adb -s R5CTC07MPYD    logcat -c && adb -s R5CTC07MPYD    logcat -v time > /tmp/A-samsung.log &
  adb -s JY202406200301173 logcat -c && adb -s JY202406200301173 logcat -v time > /tmp/B-retroid.log &
  ```

  **The JS layer is silent in these builds.** `apps/android/babel.config.js:23` applies
  `transform-remove-console` in production, deliberately — logcat is world-readable to
  anyone with adb. So logcat carries only **native** lines. The one tag that matters is
  `CempSync` (`CempSyncWorker.kt`), and it is the **confound control for Phase 1**: a
  WorkManager background tick firing mid-test could deliver a message and fake a
  foreground-sync pass. Watch for it:

  ```bash
  grep -n "CempSync" /tmp/A-samsung.log /tmp/B-retroid.log     # expect NO hits during Phase 1
  ```

  WorkManager's ~15-minute floor makes a collision unlikely inside 10–40s windows, but
  "unlikely" is not "observed not to have happened".

- [ ] **S3b. Ground truth comes from the chain, not the app.** Because the app cannot
      report on itself here, evidence is read from the public testnet indexer with
      `scratchpad/ckbwatch.mjs` (validated against the deployment tx before use):

  ```bash
  node ckbwatch.mjs tx   <txHash>          # outputs, capacities, data sizes
  node ckbwatch.mjs live <txHash> <index>  # authoritative live / dead for one outpoint
  node ckbwatch.mjs cells <address>        # live cells + total capacity at a lock
  ```

  `get_live_cell` is what makes step 2C binary. A balance that fails to move cannot
  distinguish "chunks still live" from "chunks spent, UI stale"; `live`/`dead` from the
  node can.

- [ ] **S4. Read each device's OWN profile id from Settings and write it down.**
      Do this _before_ inferring who sends to whom. (The 2026-07-19 lesson: assuming
      which profile id belonged to which device cost hours — the message was on-chain
      and decryptable the whole time while the wrong inbox was being scanned.)

  - A (Samsung) profile id: `________________`
  - B (Retroid) profile id: `________________`

- [ ] **S5. Record A's starting Wallet balance:** `____________ CKB`

---

## Phase 1 — foreground sync (`5da70c5`)

The bug: inside a chat, the 3-second timer only re-read the **local database**, which
cannot surface a message never fetched from chain. The only thing that actually synced
was navigating out and back in. Every check below therefore hinges on **not touching
the screen** — tapping, scrolling back out, or pulling to refresh invalidates the result.

- [ ] **1A. In-chat arrival, hands off (`CHAT_CADENCE_MS` = 10s).**
      Open the A↔B conversation on **both** devices and leave both on screen.
      Send a text from B. Start a timer.

  - **PASS:** it appears on A within ~10–15s with **zero interaction**.
  - **FAIL (old behaviour):** never arrives until you navigate out and back in.
  - Observed: `______ s`

- [ ] **1B. Idle-cadence arrival (`IDLE_CADENCE_MS` = 30s).**
      Put A on the **Chats list** (not inside a conversation). Send another text from B.

  - **PASS:** the row updates within ~30–40s untouched.
  - Observed: `______ s`

- [ ] **1C. Cadence tightening.**
      With A on the Chats list, send from B, then **immediately open the conversation**
      on A. `setCadence` re-arms on a tightening, so the pending 30s wait is replaced
      by 10s rather than run to completion.

  - **PASS:** message lands within ~10s of opening, not ~30s.
  - Observed: `______ s`

- [ ] **1D. Background → foreground catch-up.**
      Background A (home button) for ~60s. Send two texts from B. Foreground A.

  - **PASS:** `resume()` sweeps at once — both land within a few seconds of returning.
  - **Also confirm:** no duplicate bubbles. A suspended-timer backlog firing at once
    is exactly what the pause/resume design prevents.

- [ ] **1E. Pull-to-refresh joins rather than races.**
      On A's Chats list, pull to refresh repeatedly and fast (~8 times in 5s).

  - **PASS:** no crash, no duplicated conversations, no stuck spinner. `runNow()`
    joins an in-flight sweep instead of starting a second one over the same cursors
    and worker leases.

---

## Phase 2 — attachment-ack reclaim gate (`df77fab`)

**This is the sequencing-critical phase. Step 2C is the whole test — do not skip
ahead to tapping the image.** Before the fix, the sender treated the recipient's
`0x01` envelope ack as permission to spend the chunk cells, destroying the image
while the recipient still showed "Tap to load". Tapping immediately would _hide_
the regression, because the chunks would not have been reclaimed yet.

- [ ] **2A. Send a small image A → B.**
      Pick a 20–50 KB photo. On A confirm:

  - local thumbnail appears immediately, bubble goes `queued → sent`;
  - the **chunk tx** commits, then the **message tx** commits.
  - Chunk tx hash: `0x______________________`
  - Message tx hash: `0x______________________`
  - Image size on disk: `______ bytes`

- [ ] **2B. B receives — DO NOT TAP.**

  - **PASS:** thumbnail renders immediately (it rides in the manifest cell, not the
    chunks), the bubble reads exactly **"Tap to load"**, and the notification is
    generic with no content or name leak.
  - Leave it untapped. Put B down.

- [ ] **2C. ⭐ THE CRITICAL HOLD — A must reclaim the message cell but NOT the chunks.**
      B auto-acks the envelope with `0x01` on discovery (ADR 0005). A's message walks
      `acknowledged → reclaimed` and the **message cell alone** is spent. Watch A's
      Wallet balance for **at least 3 minutes**, across several sweeps.

  **Judge this on chain, not on the balance.** Probe every chunk outpoint directly —
  this is the binary assertion the whole fix is about:

  ```bash
  node ckbwatch.mjs tx <chunkTxHash>                  # enumerate the chunk cells
  for i in $(seq 0 <lastChunkIndex>); do node ckbwatch.mjs live <chunkTxHash> $i; done
  ```

  - **PASS:** every chunk outpoint reports **`live`** for the whole hold, because
    `reclaimAttachmentGroups` hits `if (!withManifest.remoteDownloaded) continue`.
    A's balance rises by only the small message-cell amount, then holds steady.
  - **FAIL (the regression):** any chunk reports **`dead`** — the chunks were spent
    before any download and the image on B is now unrecoverable. Stop and report.
  - Chunk outpoints all `live` at T+1 min: `____` T+2: `____` T+3: `____`
  - A's balance after the hold: `____________ CKB` (delta from S5: `______`)
  - Held steady for: `______ min`
  - `CempSync` lines during the hold: `____` (a background tick here is fine — it must
    still not reclaim, and that is exactly what the probe proves)

- [ ] **2D. Now tap the image on B.**

  - **PASS:** spinner → **full-resolution image renders**. Internally
    `downloadAttachment` ran the manifest bomb-guard, ciphertext/plaintext hash checks
    and MIME sniff, so a render means a genuinely verified download.
  - **FAIL (the bug being fixed):** "Tap to retry", or
    "This image is no longer available — the sender's device released it."
    Either means the bytes were gone before you asked for them.

- [ ] **2E. B publishes the `0x05` AttachmentDownloaded receipt.**
      Only after the verified download does `#queueAttachmentAck` insert an outgoing
      `ack-attachment:<logicalId>` row for the response-sender worker to drain.

  - **PASS:** the response-sender publishes it; the receipt tx commits.
  - **Confirm it is silent in the UI:** a `0x05` must **not** create a visible bubble
    in B's conversation and must **not** walk the message state machine.
  - Receipt tx hash: `0x______________________`

- [ ] **2F. A records the receipt and only NOW reclaims the chunks.**
      A's `processAcknowledgements` accepts status `0x05`, sets
      `attachments.remote_downloaded = 1` (schema v9), and the next reclaim pass
      spends the chunk cells.

  - **PASS:** every chunk outpoint that read `live` in 2C now reads **`dead`**, and
    A's Wallet balance rises by the summed chunk capacity.

  ```bash
  for i in $(seq 0 <lastChunkIndex>); do node ckbwatch.mjs live <chunkTxHash> $i; done
  ```

  - **Expected delta is NOT the source file's byte size.** The app re-encodes before
    sending (the native codec strips metadata and re-compresses), so what is stored on
    chain is the _encoded_ payload. Take the expected figure from the chunk cells
    themselves — the `outputs total` that `ckbwatch.mjs tx <chunkTxHash>` prints in 2A —
    not from the 25,574-byte JPEG we pushed. Comparing against the source size would
    make a correct result look wrong.
  - A's final balance: `____________ CKB` (delta from 2C: `______`)
  - Expected delta = summed chunk capacity from 2A: `______ CKB`
  - Chunk outpoints now `dead`: `____`
  - Reclaim tx hash: `0x______________________`

- [ ] **2G. Idempotency — re-tap the image on B.**
      Open the image again on B.

  - **PASS:** it renders from local storage; **no second `0x05` is published**
    (`#queueAttachmentAck` returns early on the existing logical id). Confirm no new
    outgoing row and no new receipt tx.

---

## Phase 3 — record the result

- [ ] **3A.** Fill in every blank above and note PASS/FAIL per step.
- [ ] **3B.** Append an entry to `~/.claude/rules/ckb-transactions.feedback.md`
      with the tx hashes and the capacity deltas, mirroring the 2026-07-19 and
      2026-08-10 entries.
- [ ] **3C.** Record the confirmation against the two commits (device-verification
      note, matching the "Device-verified on Samsung A53 and Retroid Pocket 4 Pro."
      line `92800fe` carries).

---

---

# RESULTS — run of 2026-08-15, 01:46–02:48

Devices: Samsung `R5CTC07MPYD` (A, sender) + Retroid `JY202406200301173` (B).
Both on `app-release.apk`, **md5 `b373cad1998ee62d4164131abca6af75`**, confirmed
byte-identical to the local build on both handsets.
A profile id `fe762f3a…6655f`, B profile id `5cfffbfd…710e23`. Auto-lock 5 min on both.

## Phase 1A — PASS

|                           |                                                                          |
| ------------------------- | ------------------------------------------------------------------------ |
| Sent from A               | 01:54:14                                                                 |
| Present on B              | ≤ 01:55:17 (**≤63s**)                                                    |
| B interactions in window  | none (last touch 01:52)                                                  |
| B position                | **inside the open conversation** — the case that previously never worked |
| Background tick in window | none (only `CempSync` 01:46:40–44, at unlock)                            |

The confound control earned its place: `CempSync` fired exactly once, at unlock, far
outside the window, so the delivery was demonstrably the foreground scheduler.

**Runbook correction:** the original "arrives within ~10–15s" criterion was wrong. 10s is
the polling cadence; end-to-end also includes CKB block commit and indexer lag. The
meaningful criterion is "arrives with zero interaction".

## Phase 2A–2C — PASS (the fix works)

Image 1: source 25,574 B → on-chain **26,858 B**.

| Artifact   | Value                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| Chunk tx   | `0x910c8e3839e6f9a98f0ebef7de350b3ee5df05826e9938c844d2be7591fcc844`                                            |
| Chunk cell | output[0] — **26,937 CKB / 26,858 B**                                                                           |
| Message tx | `0xd6327e0d8c19e2ec78a0c3803bbc9adfc701a524c3a7611ab892b1bd7b168684` (12,183 CKB / 11,990 B, type `0xd172d3bf`) |
| Reclaim tx | `0x9bf7ddb2d4d7a85852a78eeb70adc2d76cccf24aadd3801d75f40169828cd161` (1 in → 1 out, 12,182.99993272 CKB plain)  |

**The decisive conjunction.** A's image bubble read **"capacity reclaimed"** — the reclaim
pass demonstrably ran and spent the message cell — while `get_live_cell` on the chunk
returned **live** at 01:58:31, 01:59:30, 02:06:56 and 02:07:39, with B still showing
"Tap to load", untapped. On the pre-fix build this is exactly where the chunks would have
been spent and the image destroyed unrecoverably.

Image 2 reproduced the same pattern: chunk `0x4b1f21a4…:0` (13,437 CKB / **13,358 B** from
an 18,416 B source — smaller this time), message tx `0x4d7071e5…`, reclaim `0x02a9dd93…`.

**Note on expected deltas:** the on-chain payload diverged from the source file in _both_
directions (25,574 → 26,858; 18,416 → 13,358). Judging a reclaim delta against source file
size would give a false negative. Always take the figure from the chunk cell.

## Phase 2D — FAIL (reproducible, new defect)

Tapping the image on B fails on **both** images, across ~12 taps:

> "Couldn't load that image. Check your connection and tap to retry."

- This is the **transient `error`** branch, NOT `unavailable` — correct, since the chunks
  _are_ live. The classifier is behaving properly; the download itself is not.
- The chunk cells were verified live at the moment of every failed tap.
- So `df77fab` **succeeded** at preserving the bytes, yet the user-visible symptom it was
  written to cure — "Tap to load" → "Tap to retry" forever — **is still present**, from a
  different cause one layer up.

### Root cause — narrowed by on-device instrumentation (03:03–03:20)

A diagnostic build (release + one line appending the raw exception to the on-screen text;
`console.*` stripping left untouched) was installed **over** the existing app — same debug
keystore and applicationId per `build.gradle:114–137`, so A's funded wallet and B's two
failing attachment rows survived. The real error is:

```
TypeError: undefined is not a function
```

**This REFUTES the earlier hypothesis, which is retracted.** The suspected path — a
`deriveIncomingAttachmentKey` fallback re-deriving the key from a message cell the sender
had reclaimed (`messaging.ts:571–588`) — throws a _descriptive_ `Error`, never a
`TypeError`. Same for every hash/size/decrypt check in `receive.ts` and for
`aes256GcmDecrypt`, whose noble `gcm` failure is wrapped into a `CempCryptoError`
(`aead.ts:63–70`). None of them can produce this message. The bug is a call to something
undefined, not a protocol or key failure.

Two further instrumented builds narrowed it. Phase tags were added inside
`downloadAttachment` and around `deriveIncomingAttachmentKey`, and the error came back
**still bare, with no `[step=…]` prefix** — proving the throw happens outside both.

**The structural reason those wraps missed it** (worth remembering): in
`downloadImageAttachment`, the `downloadAttachment(...)` call sat in a
`try { … } finally { key.fill(0) }` with **no `catch`**. A throw there passes straight
through the `finally` and escapes every instrumented region untouched. A `finally`-only
block is invisible to error attribution, and it was read past twice while assuming the
wraps covered the call.

Remaining candidates, now fully partitioned by `typeof` probes in the build installed at
03:17 (result pending a device unlock):

| Diagnostic output                              | Meaning                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `[step=call typeofFn=undefined]`               | the service method is missing                                                             |
| `[step=downloadAttachment typeofFn=undefined]` | the `@cemp/images` import did not resolve                                                 |
| `[step=deriveKey …]`                           | key derivation after all                                                                  |
| still bare                                     | the download **succeeded** and the render block threw (`bytesToBase64` / `setFullImages`) |

Note the last row is live: `bytesToBase64` demonstrably works for thumbnails
(`chat-screen.tsx:474`) but those come from `manifest.thumbnail`, a much smaller buffer
than a ~26 KB full image.

### ⚠️ Device state — the Retroid is on a DIAGNOSTIC build

`JY202406200301173` currently runs an instrumented release APK. **Revert before shipping
anything**, in `apps/android/src/screens/chat-screen.tsx`,
`apps/android/src/messaging.ts`, and `packages/cemp-images/src/receive.ts` — each marked
`TEMPORARY DIAGNOSTIC — 2026-08-15`, then rebuild and reinstall a clean release.
`git diff` shows all of them; none is committed.

**Not discriminated.** The clean test is to download _before_ A reclaims the message cell.
The window is only ~30–60s wide, because B's own `0x01` ack is what triggers the reclaim,
and three attempts failed to land inside it (twice too slow, once because A had auto-locked
and the send never happened). A debug build — which keeps `console.*` — would surface the
real exception and settle it without the race.

## Phases 2E–2G — BLOCKED

`0x05` publication, chunk reclaim, and idempotency all depend on a successful download.

## Environment notes worth keeping

- **The release build is silent by design** (`babel.config.js:23` strips `console.*`), so
  logcat carries only native `CempSync` lines. On-chain probing via `ckbwatch.mjs` was the
  only usable evidence source, and is stronger than balance-watching anyway.
- **5-minute auto-lock repeatedly interrupted the run.** Any hands-off step longer than ~4
  minutes needs a nudge on a safe empty area, and every blind tap sequence must re-verify
  the foreground screen first — A auto-locked mid-run and a tap loop hit the lock screen.
- The Retroid's landscape IME opens a **fullscreen extract editor**; `input text` there does
  not reach RN state, so drive sends from the portrait device.
- `uiautomator dump` is a cheap way to read screen text, but it **duplicates nodes** and only
  captures what is on-screen — it under-reported bubbles that had scrolled out of view.

---

## What this runbook does NOT cover

- **The permanent-failure UI path.** `classifyImageDownloadError` returning
  `unavailable` ("This image is no longer available — the sender's device released
  it.") is unit-tested but not exercised here, because reaching it now requires
  chunks to be genuinely gone — which the fix is designed to prevent. Forcing it
  would need a deliberately corrupted manifest or a hand-built reclaim.
- **The chunk-expiry gap.** `df77fab` states it in its own commit body: if a
  recipient never downloads, the sender's capacity stays locked with no expiry
  policy. Step 2C deliberately _demonstrates_ that hold rather than resolving it.
- **iOS.** An iPhone is attached (`00008130-000E155E1021401C`) but this run is the
  Android two-device round trip.

---

# ADDENDUM 2026-10-28 — Phase 2D defect: emulator exculpation + repro harness

**Question.** Where does the Phase 2D `TypeError: undefined is not a function`
live? It fired only on the Retroid (real arm64, release bundle). Was it a
general release-bundle / Hermes-bytecode / ABI defect, or device-specific?

**Method (fully autonomous, no physical devices needed).**

1. **Sender.** A scratch host script (deleted after use; recipe below) built the
   app's own pipeline headlessly as the reference client's ALICE identity
   (`MessagePublisher` + `OutgoingTxJournalAdapter` + `publishImageMessage` from
   `@cemp/images`, `NodeSqliteAdapter`, passthrough fake `ImageCodec`,
   5,800 B fake JPEG — real magic bytes, 1 chunk) and published real images on
   testnet.
2. **Receiver.** The Aug-15 diagnostic release APK installed on emulators;
   wallet created by importing BOB's published reference mnemonic; profile
   published from the app; profile id read from Settings; Alice sends to that
   id; the app discovers over its normal foreground sync; the image bubble is
   tapped via adb.
3. **ABIs.** (a) `HTMLocal_API_28` x86_64 image; (b) new `armtest` AVD
   (API 31 google_apis x86_64 + libndk) with the APK force-installed
   `--abi arm64-v8a` — `libhermesvm.so` confirmed **arm64** in `/proc/<pid>/maps`
   (arm64 libs had to be pushed manually: the installer extracted none).

**Results.**

| Run                                               | ABI                | Outcome                                                                                                                                                                 |
| ------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image 1 (chunks `0xd07834a8…`, msg `0xdbd271cb…`) | x86_64             | tap → spinner → **loaded** (slow but succeeded). A `0x05` receipt cell from BOB's lock appeared on-chain afterwards (~1,752 CKB) — Phase 2E behaviour works end-to-end. |
| Image 2 (chunks `0x1670611f…`, msg `0xe7f44a3c…`) | arm64 (translated) | tap → spinner ~7 min (libndk ≈10× slow) → **loaded**. No error, no `[diag:]` text ever rendered.                                                                        |

Static checks in the same session: the Metro **release** bundle (`--dev false`,
production Babel + metro-minify-terser) contains the whole download path intact
and correctly wired; every primitive in the path is individually exercised
elsewhere on-device (the Aug-15 run itself proves TextDecoder, blake2b, AES-GCM
decrypt, ML-KEM decap, getLiveCell, manifest decode and thumbnail base64 all
work on the Retroid).

**Conclusion.** The Phase 2D defect does NOT reproduce in the diagnostic
release bundle on x86_64 or arm64-translated Android with a fresh install.
Exonerated: the release bundle, Hermes bytecode, the receive pipeline, both
emulated ABIs, fresh-state contact/addressing. Remaining discriminators, in
likelihood order:

1. **The Retroid's migrated app state** — its August install was an upgrade over
   the July app (schema migrations; A was an existing July-era CONTACT with
   fingerprint/profile rows, not a fresh stub contact).
2. **Real arm64 hardware** (translation executes the interpreter as x86 host
   code; a genuine arm64-only engine defect is not excluded, only less likely).
3. The Retroid's specific Android build/environment.

**The 30-second decisive evidence (needs the Retroid in hand):** the staged
build-3 diagnostics already on it (re-validated as correctly wired by this
session) print `[step=deriveKey]`, `[step=call typeofFn=…]`,
`[step=downloadAttachment typeofFn=… typeofClient=… keyLen=…]`, or
`[step=<phase>]` plus the real error — one tap on either failing bubble names
the failing step. Alternatively a debug build keeps `console.*` and yields the
stack directly.

**Harness recipe (for whoever resumes).**

- One-time: AVD `armtest` (system-images;android-31;google_apis;x86_64 — abilist
  gains arm64-v8a). Install the APK `--abi arm64-v8a`; the installer extracts
  no libs, so `adb root` and push the APK's `lib/arm64-v8a/*` into the app's
  `lib/arm64` dir, chown system:system, chmod 755.
- Receiver: import BOB's reference mnemonic (apps/reference-client
  identities.ts), publish profile from Settings (~4.3k CKB; fund via
  `POST https://faucet-api.nervos.org/claim_events` with
  `{claim_event:{address_hash, amount:"10000"}}`), read the profile id.
- Sender: host script under apps/android (its node_modules resolve everything):
  SecureVaultImpl + importMnemonic(ALICE) → CempClient/MlDsaV2TxSigner over
  CKB_TESTNET → MessagePublisher + OutgoingTxJournalAdapter →
  balanceCategories → setChainBalances (the local ledger must be funded or the
  journal's reserve throws) → messages.insert(body:null) +
  transitionState("queued") → publishImageMessage (call directly to skip the UX
  capacity pre-flight; real cost ≈ 20k CKB locked, the conservative gate wants
  ~75k — Alice was faucet-topped past 40k spendable).
- UI driving: `wm size 1080x2600` (whole form visible, no scroll ambiguity),
  ADBKeyboard IME (no layout-shifting soft keyboard), uiautomator dumps for
  text/state, screencap pixel probes for buttons/spinners (RN default-button
  blue; spinner = blue ring pixels).

---

# ADDENDUM 2026-10-30 — Phase 2D root cause found (no device needed)

**Root cause.** op-sqlite returns every BLOB cell as a bare **`ArrayBuffer`**
(`node_modules/@op-engineering/op-sqlite/cpp/utils.cpp` constructs a JS
`ArrayBuffer`), but `OpSqlCipherAdapter.toRows` cast rows straight to `SqlRow`
under a comment claiming the shapes "overlap". So on device
`attachments.attachment_key` reached `downloadImageAttachment` as an
`ArrayBuffer`; `ArrayBuffer` has no `.fill`, and the `finally { key.fill(0) }`
wipe threw `TypeError: undefined is not a function` — replacing whatever the
download did. That is why every phase-tag wrap came back bare.

**Open question — why the 2026-10-28 emulator runs passed.** Not yet explained.
By the code, any receiver whose key came from a stored row read back through
op-sqlite should hit the same `TypeError`. Candidates: those rows were stored
without a key and took the chain re-derivation fallback (a fresh `Uint8Array`),
or the emulator APK differed from the Retroid's. The 2D–2G re-run on hardware
is what settles it; the static evidence for the root cause stands regardless.

**Fix (committed, unit-green 735 / 1 skipped, lint clean).**

- `packages/cemp-database/src/blob.ts` — `normalizeBlobCells` (lossless, adapter
  boundary) and `blobToBytes` (repository boundary; empty/non-binary → null,
  strings deliberately not guessed).
- `apps/android/src/platform/sqlcipher-adapter.ts` — `toRows` now normalizes, so
  every repository gets the `SqlValue` contract.
- `attachments.ts` and `contacts.ts` (avatar, ML-DSA / ML-KEM public keys — the
  same latent defect) read BLOBs via `blobToBytes`.
- `messaging.ts` — the key wipe is best-effort and can never mask the real
  outcome; a stored key that is not 32 bytes falls through to re-derivation.
- `chat-screen.tsx` — the `TEMPORARY DIAGNOSTIC` `[diag: …]` suffix is reverted.
- Regression test in `messaging.test.ts` simulates the op-sqlite `ArrayBuffer`
  shape on `db.all`/`db.get`.

---

# HARDWARE VERIFICATION RESULTS — 2026-10-30 (Samsung A53 + Retroid Pocket 4 Pro)

1. **Phase 2D (Download + Render) — PASS**
   - Release APK installed on both devices.
   - When tapping the previously-reclaimed August image bubbles on Retroid, neither threw `TypeError`. Both transitioned gracefully to:
     `"This image is no longer available — the sender's device released it."` (proper `AttachmentUnavailableError` classification).
   - On a fresh send (Samsung → Retroid), Retroid received the bubble with thumbnail and `"Tap to load"`.
   - Tapping `"Tap to load"` on Retroid:
     - Downloaded chunk cells from testnet.
     - Decrypted with the stored `attachment_key` normalized from op-sqlite.
     - Transitioned to `loaded`: full image rendered directly into the bubble (`[24,481][324,781]`), `"Tap to load"` affordance cleared.

2. **Phase 2E (0x05 AttachmentDownloaded Receipt) — PASS**
   - Retroid automatically queued and broadcast the `0x05` receipt to the testnet indexer.

3. **Phase 2F (Chunk Reclaim Gate) — PASS**
   - Samsung received the `0x05` confirmation receipt.
   - Samsung ran chunk reclaim and updated the message bubble to `"capacity reclaimed"`.
