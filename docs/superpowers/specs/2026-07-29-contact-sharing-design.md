# Contact sharing via QR — design

Date: 2026-07-29
Status: slice 1 (share path) IMPLEMENTED and device-verified 2026-07-30 — see
`docs/superpowers/plans/2026-07-29-contact-sharing-slice-1-share.md`. Slices 2
(photo scan + paste + add-contact flow) and 3 (camera) are still to be planned.

## Problem

There is no way to give someone your CellSend identity. A contact is a
`profileIdHex` plus a local display name (`packages/cemp-database/src/repositories/contact.ts`),
and the only way to obtain one today is to read a 64-character hex string off
the Settings screen and retype it. That is unusable in person and impossible
to forward.

## Goals

1. Show your own contact as a QR code another device can scan.
2. Forward that card to someone who may not have CellSend yet, so they can add
   you.
3. Scan a contact code from either the live camera or a saved photo — because
   a forwarded card arrives as an image in another app.

## Non-goals (v1)

- **Avatars in the card.** Even a 2 KB thumbnail forces a dense QR that scans
  poorly once a messaging app has recompressed the image.
- **In-app contact messages.** Forwarding travels via the OS share sheet, so
  no new message content type and no card-bubble rendering.
- **Deep-link handling.** Registering a URL scheme on both platforms plus a
  `Linking` handler is deferred. The payload is bundle JSON rather than a URI,
  so there is no link to tap in any case: the share caption carries the bundle
  text and the scan screen accepts it pasted, which covers the
  scan-failed fallback with zero platform configuration.
- **Third-party introductions** ("forward Bob's card to Carol").

## Decisions

| Question                  | Decision                                                         | Why                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forward transport         | OS share sheet only                                              | Reaches people not yet on CellSend; avoids a new message content type entirely                                                                                                                                                                                                                                    |
| Card payload              | The EXISTING `ContactBundleV1` (spec §5.4), unchanged            | It is already "the QR payload for contact exchange", already fuzz-tested, and carries the fingerprint and network that a hand-rolled URI would have dropped                                                                                                                                                       |
| Display name              | Rides in the share caption, never in the QR                      | Keeps a spec'd, fuzz-tested wire format untouched — no v2, no v1/v2 compatibility branch, no re-fuzzing                                                                                                                                                                                                           |
| Share artifact            | QR PNG + text caption                                            | The image is what makes "scan from a forwarded photo" possible at all; the caption is the copyable fallback                                                                                                                                                                                                       |
| Camera implementation     | Own native module, house style                                   | Matches CempKdf / CempImageCodec / CempImagePicker / CempScheduler; no new JS dependency and no new CocoaPods surface on a CI whose `pod install` is already the flakiest step                                                                                                                                    |
| "My display name" storage | The pre-existing dormant `settings` table (v1); NO schema change | Superseded the original "new `local_settings` table at v9" during implementation: a structurally identical `settings` table had existed since schema v1, unused by any application code. Migrations are append-only, so adding a duplicate would have carried one dead table forever. `SCHEMA_VERSION` stays at 8 |

### Rejected alternative: pure-JS QR decoding

`NativeImageCodec.decode()` returns an **opaque native bitmap handle** by
design — "the JS side never touches raw pixels, only the opaque handle"
(`apps/android/src/platform/native-image-codec.ts`). Feeding a JS decoder such
as jsQR would require adding a `readPixels()` bridge method and moving a
multi-megabyte RGBA buffer across as hex. Decoding stays native.

## Architecture

Four layers, split so that everything except camera access and the share sheet
is RN-free and unit-testable:

| Layer                  | Location                                                                            | Tested by        |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| Card codec             | `packages/cemp-core/src/contact-bundle.ts` — **exists, unchanged**                  | vitest (already) |
| Own-bundle assembly    | `MessagingService#myContactBundle()`                                                | vitest           |
| QR matrix + PNG writer | `packages/cemp-core/src/qr/`                                                        | vitest           |
| Native seams           | `apps/android/src/platform/native-qr-scanner.ts`, `native-share.ts` (+ Kotlin/ObjC) | device           |
| Screens                | `apps/android/src/screens/`                                                         | device           |

### Card format — reuse, do not invent

`packages/cemp-core/src/contact-bundle.ts` already defines the contact-exchange
payload and describes itself as "the QR payload for contact exchange"
(spec §5.4, Phase 5 task 9). It is implemented, exercised by
`hardening-fuzz.test.ts` and `profile-security.test.ts`, and has **no UI
consumer** — the missing piece is exactly the QR, share and scan surface this
design adds.

```json
{
  "protocol": "cemp-contact",
  "version": 1,
  "network": "ckb_testnet",
  "profileTypeId": "0x…64hex",
  "lockScriptHash": "0x…64hex",
  "address": "ckt1…",
  "fingerprint": "XXXX-XXXX-…-XXXX"
}
```

`encodeContactBundle(bundle)` produces the QR text;
`decodeContactBundle(text, expectedNetwork = CKB_TESTNET.name)` parses a scan
and already rejects unknown protocol/version, wrong network (rule 11), bad
hex/bech32 shapes and non-canonical fingerprints. **No new codec is written.**

An earlier draft of this design proposed a bespoke `cemp://contact?v=1&id=&n=`
URI. It was rejected on discovery of the above: it dropped the `fingerprint`
(losing the `profile-trust.ts` verification path), dropped `network` (letting a
testnet build accept a mainnet contact, breaking rule 11), dropped
`lockScriptHash` and `address`, and identified contacts by profile id rather
than profile Type ID.

### Building your own bundle

`MessagingService` already exposes every field: `identity()` returns `address`
and `lockScriptHash`, `myProfileId()` returns the profile Type ID, and
`myFingerprint()` returns the display-form fingerprint. A new
`myContactBundle(): Promise<ContactBundleV1 | null>` composes them, returning
`null` when no profile has been published.

That `null` is a real user-facing state, not an error: **a card cannot exist
before the profile is published**, because three of its five fields come from
the on-chain profile. The My Card screen must handle it by directing the user
to Settings → Publish my profile.

### QR encoding and PNG output

The QR encoder is a pinned pure-JS library (`qrcode-generator` or equivalent
with no native or DOM dependency) rather than hand-rolled: correct
Reed-Solomon error correction is not worth reimplementing, and a wrong matrix
fails in the field rather than at build time. It is used only for its module
matrix, not for rendering.

The PNG writer is ~100 lines written in-repo, emitting 8-bit greyscale with
**stored (uncompressed) deflate blocks** — valid PNG requiring no zlib
dependency. Starting geometry: 8 physical pixels per QR module with a 4-module
quiet zone; the real bundle payload (measured below) encodes as an 81x81
(version 16) matrix, giving a 712x712 px, ~507 KB image. That figure is a
starting point subject to device checklist item 4; if recompression breaks
scanning, module size rises before anything else changes.

### Native surface

Two modules, each mirroring `CempImagePicker`'s launch-and-resolve shape — a
promise-returning method rather than an RN view component, so no custom native
view needs writing or reviewing:

```
CempQrScanner.scanWithCamera(): Promise<string | null>
CempQrScanner.scanImage(bytesHex: string): Promise<string | null>
CempShare.shareImage(pngHex: string, caption: string): Promise<void>
```

- `null` means "user cancelled" (scanner) or "no code found" (image); errors
  reject.
- iOS: AVFoundation capture + Vision `VNDetectBarcodesRequest`;
  `UIActivityViewController` for sharing.
- Android: CameraX + MLKit barcode scanning; `Intent.ACTION_SEND` for sharing.

`CempShare` exists because React Native has no filesystem API. The PNG must be
written to a temp file before the share sheet can carry it, and doing that
natively avoids adding `react-native-fs` for one call.

### Storage

A schema migration adds:

```sql
CREATE TABLE local_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

with `my_display_name` as its first key. `SCHEMA_VERSION` bumps from 8 to 9.
The name is not secret — it is printed on a QR handed to strangers — but it
lives in the encrypted database for consistency with all other user data.

## Data flow

**Share:**

1. My Card screen calls `myContactBundle()`. If it returns `null`, the screen
   shows "Publish your profile first" and links to Settings — no QR is drawn.
2. `encodeContactBundle()` produces the QR text; the QR encoder builds a module
   matrix; the PNG writer emits image bytes.
3. The matrix renders on screen for in-person scanning.
4. `[Share]` reads `my_display_name` for the caption and calls
   `CempShare.shareImage(pngHex, caption)`. The caption carries the name and
   the bundle JSON; the QR carries the bundle alone.

**Receive:**

1. Scan screen offers _Scan with camera_, _Scan from photo_, and _Paste code_.
2. Camera → `scanWithCamera()`. Photo → `pickImage()` (existing) →
   `scanImage(hex)`. Paste → the text box directly.
3. `decodeContactBundle(text)` validates the result, rejecting wrong-network
   bundles per rule 11.
4. On success the add-contact form opens with an **empty, required** name field
   and the fingerprint shown for out-of-band verification.
5. Saving writes through `ContactRepository`.

## Error handling

Each of these is a distinct user-visible state, never a swallowed throw. This
matters here specifically: the 2026-07-29 vault bug showed that collapsing
unrelated failures into one message sends the user round an unwinnable loop.

| Condition                              | Behaviour                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| No profile published yet (own card)    | "Publish your profile first" + link to Settings; no QR drawn                 |
| Not a `cemp-contact` bundle            | "That isn't a CellSend contact code."                                        |
| Unknown protocol or version            | "This code was made by a newer version of CellSend."                         |
| **Wrong network** (mainnet on testnet) | "That contact is on a different network." — rule 11, never silently accepted |
| Malformed hex, bech32 or fingerprint   | "That contact code is damaged."                                              |
| `profileTypeId` already in contacts    | Offer to open the existing contact; never create a duplicate                 |
| `profileTypeId` is the user's own      | "That's your own card."                                                      |
| No code found in the chosen image      | "No contact code found in that image."                                       |
| Camera permission denied               | Honest message naming the permission                                         |
| Share sheet cancelled                  | Silent, not an error                                                         |

The first six are all raised by the existing `decodeContactBundle`, which
throws a single error type. Mapping its failure reasons onto these distinct
messages is UI work in the scan screen, not new validation logic.

Camera and photo-library usage require `NSCameraUsageDescription` and
`NSPhotoLibraryUsageDescription` (iOS `Info.plist`) and `CAMERA` (Android
manifest). Missing strings cause an immediate iOS crash on first use, so they
are part of the first implementation task, not an afterthought.

## Testing

**Unit (vitest), on Linux:**

- Card codec: **no new tests** — `contact-bundle.ts` is unchanged and already
  covered by `hardening-fuzz.test.ts` and `profile-security.test.ts`.
- `myContactBundle()`: returns `null` with no published profile; composes all
  five fields correctly when one exists; network is always the configured one.
- QR encoder: matrix output checked against known-answer vectors at the exact
  payload size a real bundle produces (427 characters, materially denser
  than the rejected URI — this is the size that must be proven scannable).
- PNG writer: header, IHDR dimensions, and CRC validity; output decodes with an
  independent reader.
- Duplicate and self-card detection by `profileTypeId`, given a contact list.

**Device checklist** (the parts vitest cannot reach):

1. QR renders and is scannable by a second phone.
2. Share sheet appears; the image arrives intact through at least one
   recompressing app (WhatsApp or equivalent).
3. Scan from camera adds a contact.
4. Scan from a photo that has been through that recompression adds a contact.
5. Camera permission denial shows the honest message rather than crashing.
6. Duplicate scan offers the existing contact instead of creating a second.

The device checklist exists because the native seams cannot run under vitest —
the same gap that let the vault database bug ship. It is a required part of the
work, not optional verification.

## Open risks

- **MLKit barcode scanning adds an Android dependency.** It is a Google Play
  Services library; size and availability on devices without Play Services need
  checking during implementation. ZXing is the fallback.
- ~~**Recompression fidelity is unproven**~~ — **CLOSED 2026-07-30.** The
  bundle JSON is 427 characters against the ~90 of the rejected URI, so the QR
  is materially denser and less tolerant of compression artefacts — encoding at
  ECC M as an 81x81 (version 16) matrix, an 8px/module, 4-module quiet-zone PNG
  comes out 712x712 px (~507 KB). That density was the open question. It is now
  answered from both directions:

  - **On device:** a card exported from the app through Telegram, then read back
    with a third-party QR reader, parsed every field correctly.
  - **Synthetically:** the production card was re-encoded as JPEG at qualities
    90/80/70/50 at full size, and at 70/50 downscaled to 512 and 360 px, and at
    quality 40 downscaled to 256 px — a 64% linear reduction plus aggressive
    JPEG. All nine variants decoded to the exact 427-byte payload under an
    independent decoder (ZBar), byte-compared against `encodeContactBundle`'s
    own output.

  8 px/module therefore carries real margin, and slice 2's scan-from-photo path
  can assume it. Raise module size only if a specific transport is found that
  degrades harder than quality-40-at-256 px.

- **Profile-id lookup is a public-RPC read.** Adding a contact resolves the id
  through `https://testnet.ckb.dev`, so the endpoint operator learns which
  profile ids a user resolves. Pre-existing, not introduced here, but worth
  recording while contacts are being designed.
