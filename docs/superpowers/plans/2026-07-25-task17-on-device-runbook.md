# Task 17 — On-device round-trip runbook (image messaging)

**Status:** user-executed acceptance gate. Tasks 1–16 complete + green (integration gate:
`vitest` 594 pass, Kotlin compiles, debug APK assembles). This is the ground-truth proof
per spec §5, mirroring the 2026-07-23 text e2e.

**Devices (from prior sessions):** Samsung `R5CTC07MPYD` (funded/sender), Retroid
`JY202406200301173` (capacity-bound ~4,512 CKB → receive-only).

**APK:** `apps/android/android/app/build/outputs/apk/debug/app-debug.apk` (already built).

---

## ⚠️ Capacity reality — read first

On-chain storage costs ~1 CKB per byte, so an image send **locks roughly its own byte-size
in CKB** (reclaimable after ack). A 512 KB image ≈ ~525,000 CKB; even a ~50 KB image ≈
~50,000 CKB. The **pre-flight (5A) will correctly block** an under-funded send with "Not
enough balance to send this image." — so:

- Fund the **Samsung** generously via faucet, OR
- Send a **deliberately small** first image (a tiny/low-res photo) to keep the locked
  capacity within the wallet's available balance for the first proof.
- The Retroid stays **receive-only** (it can't fund a send).

If the send is blocked by the pre-flight, that's the 5A gate working — top up and retry.

---

## Steps

- [ ] **1. Install the debug APK on both devices**
  ```bash
  adb -s R5CTC07MPYD install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk
  adb -s JY202406200301173 install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk
  ```
  (Metro: if serving JS from dev, mirror the 2026-07-23 setup — Metro on :8082,
  `adb -s <serial> reverse tcp:8081 tcp:8082` per device.)

- [ ] **2. Confirm each device's own profile id (Settings)** BEFORE inferring who sends to whom
  (the 2026-07-19 lesson: read each device's own profile id first; don't infer the inbox from
  message flow).

- [ ] **3. Send an image with EXIF/GPS from the Samsung → Retroid contact.**
  Pick a photo that HAS EXIF/GPS (a real camera photo). Confirm on the Samsung:
  - the outgoing bubble shows the **local thumbnail immediately** with `queued → sent`;
  - the **chunk tx** commits, then the **message tx** commits (note both tx hashes).

- [ ] **4. Receive + render on the Retroid.**
  - thumbnail appears **immediately** (no fetch — it rode in the manifest cell);
  - notification is **generic** (no content/name leak);
  - **tap** the bubble → spinner → **full-res renders**. (Internally `downloadAttachment`
    ran `checkManifest` bomb-guard + ciphertext/plaintext hash checks + mime-sniff; a failure
    would show 7A "Couldn't load full image — tap to retry" with the thumbnail retained.)

- [ ] **5. Prove metadata stripping (5A / the security guarantee).**
  Pull the rendered full-res image off the Retroid and check for EXIF/GPS:
  ```bash
  adb -s JY202406200301173 exec-out run-as com.cempmobile.debug cat <app-cache-path>/<file> > /tmp/received.webp
  # or export/share it off-device, then:
  exiftool /tmp/received.webp | grep -iE "gps|orientation|make|model" || echo "no EXIF/GPS — PASS"
  ```
  Expected: **no GPS/EXIF tags**, and the image displays **right-side-up** (orientation baked
  into pixels). This is the on-device proof that the native codec strips metadata by
  construction.

- [ ] **6. Confirm reclaim after ack.**
  After the Retroid auto-acks, confirm the **Samsung reclaims the chunk cells**
  (`reclaimAttachmentGroup` path) — locked capacity returns to the sender.

- [ ] **7. Record the result** (tx hashes, EXIF-strip PASS/FAIL, capacity reclaimed) in the
  session notes / ckb-transactions feedback log, mirroring the 2026-07-23 text e2e entry.

---

## Testing hygiene (hard-won from prior on-device sessions)

- Drive **unlock → navigate → send as ONE uninterrupted adb burst**; the vault auto-locks on
  an inactivity deadline and host-side parsing gaps between taps can trip it.
- Verify every UI step against `uiautomator dump` **bounds**, not fixed coordinates (blind
  taps cost cycles before).
- `cmd jobscheduler run -f` does NOT force periodic WorkManager work — for a locked-receive
  test use the documented force path from the Phase 9 notes.

## Known follow-ups to watch for on-device (from reviews — not blockers to the round-trip)

- **Image send not retryable on publish failure** (see progress ledger): if the send fails at
  publish, the bubble may stick at "sending" with nothing to resend. If you hit this, it's the
  documented gap — note it; the fix (persist compressed bytes for retry, or mark failed with a
  retry affordance) is a pre-ship follow-up.
- Image bubble is a fixed 200×200 box (no aspect ratio yet) — cosmetic.
