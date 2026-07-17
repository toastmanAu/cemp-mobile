import { codec } from "@cemp/core";
import { buildSendMessageTx } from "@cemp/ckb";
import {
  StepFailure,
  assembleTextMessage,
  broadcastAndCheckpoint,
  cempMessageTypeRef,
  checkProfileFingerprint,
  formatCkb,
  resolveLiveProfile,
} from "./shared.js";
import type { StepFn } from "./shared.js";
import type { MessageMapping } from "../state.js";

/**
 * respond — Bob → Alice: a text response that (spec §9) sets
 * reply_to_message_id AND reply_to_outpoint (what makes Alice's original
 * cell reclaim-eligible) and piggybacks the `downloaded` receipt for her
 * message. Encrypted to Alice's current-epoch route tag; sender-owned by
 * Bob (rule 9).
 */

export const RESPOND_TEXT = "hi alice — got you";

interface RespondPending extends Record<string, unknown> {
  messageId: string;
  routeTag: string;
  conversationId: string;
  capacity: string;
  fee: string;
}

export const stepRespond: StepFn = async (ctx, log) => {
  if (ctx.shared.steps.respond === true) {
    log(
      `respond already complete (checkpoint): tx ${ctx.shared.messages.bobToAlice?.txHash ?? "?"}`,
    );
    return;
  }
  const bob = ctx.identities.bob;
  const aliceRecord = ctx.shared.profiles.alice;
  const bobRecord = ctx.shared.profiles.bob;
  const original = ctx.shared.messages.aliceToBob;
  if (aliceRecord === null || bobRecord === null) {
    throw new StepFailure("profiles missing — run the profiles step first");
  }
  if (original === null) {
    throw new StepFailure("no alice→bob message to respond to — run the send step first");
  }
  const received = bob.state.messages.find(
    (record) => record.direction === "received" && record.messageId === original.messageId,
  );
  if (received === undefined) {
    throw new StepFailure("bob has not received alice's message — run the receive step first");
  }

  // Resolve Alice's profile cell (her current KEM key), fingerprint-checked.
  const resolved = await resolveLiveProfile(ctx.client, aliceRecord.profileId);
  checkProfileFingerprint(resolved, aliceRecord);

  const originalMessageId = codec.hexToBytes(original.messageId);
  const message = assembleTextMessage({
    text: RESPOND_TEXT,
    senderProfileId: codec.hexToBytes(bobRecord.profileId),
    recipientProfileId: codec.hexToBytes(aliceRecord.profileId),
    recipientKemPublicKey: resolved.profile.ml_kem_public_key,
    senderDeviceId: codec.hexToBytes(bob.state.deviceId),
    replyTo: { messageId: originalMessageId, outPoint: original.outPoint },
    receipts: [{ messageId: originalMessageId, status: 0x01 }], // downloaded
    receiptRequest: 0x00,
  });
  log(
    `assembled response ${codec.bytesToHex(message.messageId)} replying to ${original.messageId} ` +
      `(${original.outPoint.txHash}:${original.outPoint.index}) with a downloaded receipt`,
  );

  const typeRef = cempMessageTypeRef(ctx);
  const result = await broadcastAndCheckpoint<RespondPending>(
    ctx,
    "respond",
    log,
    async () => {
      const built = await buildSendMessageTx({
        envelopeBytes: message.envelopeBytes,
        routeTag: message.routeTag,
        conversationTag: message.conversationTag,
        messageNonce: message.messageNonce,
        sender: bob.signer,
        cempMessageType: typeRef,
      });
      const capacity = built.tx.outputs[0]!.capacity;
      log(`response cell: capacity ${formatCkb(capacity)} CKB, lock = bob (sender-owned, rule 9)`);
      return {
        built,
        signer: bob.signer,
        metadata: {
          direction: "bob→alice",
          messageId: codec.bytesToHex(message.messageId),
          replyToMessageId: original.messageId,
          replyToOutpoint: `${original.outPoint.txHash}:${original.outPoint.index}`,
          receipts: [{ messageId: original.messageId, status: "0x01 downloaded" }],
          routeTag: codec.bytesToHex(message.routeTag),
          capacity: capacity.toString(),
        },
        pendingData: {
          messageId: codec.bytesToHex(message.messageId),
          routeTag: codec.bytesToHex(message.routeTag),
          conversationId: codec.bytesToHex(message.conversationId),
          capacity: capacity.toString(),
          fee: built.estimatedFee.toString(),
        },
      };
    },
    (committed) => {
      const mapping: MessageMapping = {
        messageId: committed.messageId,
        from: "bob",
        to: "alice",
        txHash: committed.txHash,
        outPoint: { txHash: committed.txHash, index: "0x0" },
        routeTag: committed.routeTag,
        conversationId: committed.conversationId,
        capacity: committed.capacity,
        fee: committed.fee,
      };
      ctx.shared.messages.bobToAlice = mapping;
      bob.state.messages.push({
        messageId: committed.messageId,
        direction: "sent",
        peerProfileId: aliceRecord.profileId,
        txHash: committed.txHash,
        outPoint: mapping.outPoint,
        status: "published",
        recordedAt: new Date().toISOString(),
      });
      bob.state.fees.respond = committed.fee;
      ctx.save();
    },
  );
  if (!result.skipped) {
    log(`respond complete: ${result.txHash}`);
  }
};
