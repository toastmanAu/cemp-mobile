# @cemp/images

CKBFS image transport for CEMP Mobile (spec §9, Phase 10). Platform-neutral
pipeline: image codecs are a rule-14 seam (`ImageCodec`), everything else —
compression policy, encryption, chunking, manifests, chunk publish, download,
group reclaim — is tested headlessly here.

## Flow (spec §9.2)

```text
source image
→ decode (EXIF orientation baked in, metadata dropped by re-encode)
→ aspect-preserving resize (progressive: dimensions, then quality)
→ WebP/JPEG within limits (≤ 512 KB preferred, 1 MB hard)
→ AES-256-GCM under the envelope-derived attachment key (never transported:
   both sides derive it from the KEM shared secret, CEMP-ATTACHMENT-KEY-V1)
→ 32 KiB chunks → one batched data-cell tx (journaled pre-broadcast, rule 6)
→ AttachmentManifestV1 inside the message payload (content_type 0x03)
→ recipient validates the manifest BEFORE fetching (decompression-bomb
   guard), downloads chunks, cipher-hash → decrypt → content-hash →
   magic-sniff vs declared mime
→ group reclaim: message + root + every chunk in ONE tx (no orphan cells)
```

## Pieces

| Module                | Phase 10 tasks | Notes                                                                                                                                               |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits.ts`           | 3, 5           | Aspect-preserving fit math; limits from `PROTOCOL_LIMITS`.                                                                                          |
| `codec.ts`            | 1–4            | `ImageCodec` seam (Android native codec at device phase) + magic-byte sniffing.                                                                     |
| `compress.ts`         | 3–5            | Progressive dimension→quality retreat; hard fail above 1 MB.                                                                                        |
| `prepare.ts`          | 2–6            | Decode → resize → encode → thumbnail → content hash; capacity estimate.                                                                             |
| `encrypt.ts`          | 7              | AES-256-GCM, AAD = attachment id; `blake2b256` content addressing.                                                                                  |
| `encrypt.ts` (chunks) | 8              | 32 KiB positional split/join; 1 MB ≤ 32 cells.                                                                                                      |
| `manifest.ts`         | 9, 11          | `AttachmentManifestV1` construction + pre-download validation.                                                                                      |
| `send.ts`             | 8–10           | `prepareAttachmentChunks` → `publishAttachmentChunks` (journal purpose `attachment-chunks:<id>`, crash-resume) → `buildManifestForCommittedChunks`. |
| `receive.ts`          | 11–12          | Pre-fetch manifest check; chunk download; cipher hash → decrypt → content hash → mime sniff.                                                        |
| `reclaim.ts`          | 14–15          | One batched group reclaim (`reclaim-attachment:<groupId>`), capacity returned; remote-reclaim detection via the Phase 8 watch machinery.            |

Attachment receipts (task 13) travel as the 0x01 receipt in the response
payload — the Phase 8/9 response machinery handles them once a download
succeeds. The image picker (task 1) is an app-screen concern; this package
takes encoded image bytes.

## Key and privacy notes

- **No key transport:** the attachment key is HKDF-derived from the envelope's
  ML-KEM shared secret under `CEMP-ATTACHMENT-KEY-V1` on both sides
  (`encryptEnvelope`/`decryptEnvelope` return it; callers wipe it).
- **No plaintext on-chain:** every chunk is a slice of the ciphertext
  (asserted in tests — exit criterion "no plaintext image appears on-chain").
- **No metadata:** decode→re-encode strips EXIF/GPS; orientation is baked
  into pixels at decode (spec §9.1).
- Chunk cells cost ~1 CKB per byte of ciphertext plus occupied overhead — a
  500 KB image locks ~17,000 CKB until reclaimed; `prepare.ts` exposes the
  estimate for the pre-send capacity display (task 6).
