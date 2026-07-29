# Contact sharing via QR — design

Date: 2026-07-29
Status: approved (design), not yet planned or implemented

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
- **Deep-link handling.** Registering the `cemp://` URL scheme on both
  platforms plus a `Linking` handler is deferred. The share caption still
  carries the link as copyable text, and the scan screen accepts a pasted
  link, which covers the fallback case with zero platform configuration.
- **Third-party introductions** ("forward Bob's card to Carol").

## Decisions

| Question                  | Decision                                       | Why                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forward transport         | OS share sheet only                            | Reaches people not yet on CellSend; avoids a new message content type entirely                                                                                                 |
| Card payload              | Profile id + display name                      | Contacts arrive with an editable name instead of raw hex; still a low-density QR                                                                                               |
| Share artifact            | QR PNG + text caption                          | The image is what makes "scan from a forwarded photo" possible at all; the caption is the copyable fallback                                                                    |
| Camera implementation     | Own native module, house style                 | Matches CempKdf / CempImageCodec / CempImagePicker / CempScheduler; no new JS dependency and no new CocoaPods surface on a CI whose `pod install` is already the flakiest step |
| "My display name" storage | New `local_settings` table in the encrypted DB | Reusable for later preferences; consistent with contacts living in the encrypted DB                                                                                            |

### Rejected alternative: pure-JS QR decoding

`NativeImageCodec.decode()` returns an **opaque native bitmap handle** by
design — "the JS side never touches raw pixels, only the opaque handle"
(`apps/android/src/platform/native-image-codec.ts`). Feeding a JS decoder such
as jsQR would require adding a `readPixels()` bridge method and moving a
multi-megabyte RGBA buffer across as hex. Decoding stays native.

## Architecture

Four layers, split so that everything except camera access and the share sheet
is RN-free and unit-testable:

| Layer                  | Location                                                                            | Tested by |
| ---------------------- | ----------------------------------------------------------------------------------- | --------- |
| Card codec             | `packages/cemp-core/src/contact-card.ts`                                            | vitest    |
| QR matrix + PNG writer | `packages/cemp-core/src/qr/`                                                        | vitest    |
| Native seams           | `apps/android/src/platform/native-qr-scanner.ts`, `native-share.ts` (+ Kotlin/ObjC) | device    |
| Screens                | `apps/android/src/screens/`                                                         | device    |

Card parsing is the security-sensitive component: a scanned QR is
attacker-controlled input (AGENTS.md rule 4). It lives where vitest can hammer
it with hostile cases.

### Card format

```
cemp://contact?v=1&id=<64 lowercase hex>&n=<url-encoded display name>
```

- `v` — format version. Present so a future field cannot silently misparse on
  an older client; an unknown version is rejected with a distinct message.
- `id` — the contact's public profile id, exactly 64 lowercase hex characters.
- `n` — display name, URL-encoded, maximum 64 characters after decoding.
  Optional: a card without `n` parses successfully and leaves the name blank.

`encodeContactCard(card): string` and `parseContactCard(text): ParsedCard`
round-trip. `parseContactCard` validates scheme, host, version, id length and
charset, and name length, rejecting anything else.

The two directions treat an over-long name differently, deliberately: `encode`
**truncates** to 64 characters, because the input is the user's own name and
refusing to build their card would be obstructive; `parse` **rejects**, because
the input is attacker-controlled and silently accepting an oversized field is
how parsers grow holes.

### QR encoding and PNG output

The QR encoder is a pinned pure-JS library (`qrcode-generator` or equivalent
with no native or DOM dependency) rather than hand-rolled: correct
Reed-Solomon error correction is not worth reimplementing, and a wrong matrix
fails in the field rather than at build time. It is used only for its module
matrix, not for rendering.

The PNG writer is ~100 lines written in-repo, emitting 8-bit greyscale with
**stored (uncompressed) deflate blocks** — valid PNG requiring no zlib
dependency. Starting geometry: 8 physical pixels per QR module with a 4-module
quiet zone, giving roughly a 300–400 px image. That figure is a starting point
subject to device checklist item 4; if recompression breaks scanning, module
size rises before anything else changes.

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

1. My Card screen reads `my_display_name` and the published profile id.
2. `encodeContactCard()` builds the URI; the QR encoder builds a module matrix;
   the PNG writer emits image bytes.
3. The matrix renders on screen for in-person scanning.
4. `[Share]` calls `CempShare.shareImage(pngHex, caption)`.

**Receive:**

1. Scan screen offers _Scan with camera_, _Scan from photo_, and _Paste link_.
2. Camera → `scanWithCamera()`. Photo → `pickImage()` (existing) →
   `scanImage(hex)`. Paste → the text box directly.
3. `parseContactCard()` validates the result.
4. On success the add-contact form opens prefilled with an editable name.
5. Saving writes through `ContactRepository`.

## Error handling

Each of these is a distinct user-visible state, never a swallowed throw. This
matters here specifically: the 2026-07-29 vault bug showed that collapsing
unrelated failures into one message sends the user round an unwinnable loop.

| Condition                         | Behaviour                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| Not a `cemp://contact` URI        | "That isn't a CellSend contact code."                        |
| Unknown version                   | "This code was made by a newer version of CellSend."         |
| Malformed id (length or charset)  | "That contact code is damaged."                              |
| Profile id already in contacts    | Offer to open the existing contact; never create a duplicate |
| Profile id is the user's own      | "That's your own card."                                      |
| No code found in the chosen image | "No contact code found in that image."                       |
| Camera permission denied          | Honest message naming the permission                         |
| Share sheet cancelled             | Silent, not an error                                         |

Camera and photo-library usage require `NSCameraUsageDescription` and
`NSPhotoLibraryUsageDescription` (iOS `Info.plist`) and `CAMERA` (Android
manifest). Missing strings cause an immediate iOS crash on first use, so they
are part of the first implementation task, not an afterthought.

## Testing

**Unit (vitest), on Linux:**

- Card codec: encode/parse round-trip; missing name; unicode and
  percent-encoded names; over-length name; wrong scheme, host, and version;
  id of wrong length or containing non-hex; empty and junk input.
- QR encoder: matrix output checked against known-answer vectors for the exact
  payload lengths this feature produces.
- PNG writer: header, IHDR dimensions, and CRC validity; output decodes with an
  independent reader.
- Duplicate and self-card detection, given a contact list.

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
- **Recompression fidelity is unproven.** Whether a QR survives WhatsApp-grade
  recompression at the chosen module size is an empirical question; device
  checklist item 4 is the gate, and the module size may need raising.
- **Profile-id lookup is a public-RPC read.** Adding a contact resolves the id
  through `https://testnet.ckb.dev`, so the endpoint operator learns which
  profile ids a user resolves. Pre-existing, not introduced here, but worth
  recording while contacts are being designed.
