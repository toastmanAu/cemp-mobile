import { assembleTextMessageV3 } from "@cemp/ckb";
import { codec } from "@cemp/core";
import { deriveIdentityKeys } from "@cemp/crypto";
import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_MESSAGE_CELL_SHANNON,
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

  it("bounds the LARGEST v3 manifest message cell (ADR 0007: +3,309-byte signature)", () => {
    // A 32 KiB thumbnail (the manifest cap) and a 1 MB image's chunk list,
    // sealed as the production sender does: v3, signed. The cell locks
    // 8 (capacity) + 70 (ML-DSA lock) + 114 (message type) + data bytes,
    // plus the builder's 1 CKB margin; padding is random, so take the max.
    const sender = deriveIdentityKeys(new Uint8Array(64).fill(7));
    const recipient = deriveIdentityKeys(new Uint8Array(64).fill(17));
    const manifest = {
      ...codec.buildAttachmentManifest({ seed: 3, withThumbnail: false, chunkCount: 33 }),
      thumbnail: new Uint8Array(32_768),
    };
    let largest = 0;
    for (let i = 0; i < 20; i++) {
      const bytes = assembleTextMessageV3({
        text: "",
        contentType: 0x03,
        attachmentManifests: [manifest],
        senderProfileId: new Uint8Array(32).fill(1),
        signerSecretKey: sender.mlDsa.secretKey,
        signerPublicKey: sender.mlDsa.publicKey,
        recipientProfileId: new Uint8Array(32).fill(2),
        recipientKemPublicKey: recipient.mlKem.publicKey,
        senderDeviceId: new Uint8Array(16),
        receiptRequest: 1,
      }).envelopeBytes.length;
      largest = Math.max(largest, bytes);
    }
    const occupiedCkb = BigInt(8 + 70 + 114 + largest) + 1n;
    expect(CONSERVATIVE_MESSAGE_CELL_SHANNON).toBeGreaterThanOrEqual(occupiedCkb * 100_000_000n);
  });
});
