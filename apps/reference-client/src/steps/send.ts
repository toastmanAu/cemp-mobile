import { codec } from "@cemp/core";
import { buildSendMessageTx } from "@cemp/ckb";
import {
  StepFailure,
  assembleTextMessage,
  broadcastAndCheckpoint,
  cempMessageTypeRef,
  checkProfileFingerprint,
  currentRoutingEpoch,
  formatCkb,
  resolveLiveProfile,
} from "./shared.js";
import type { StepFn } from "./shared.js";
import type { MessageMapping } from "../state.js";

/**
 * send — Alice → Bob: resolve Bob's profile cell by Type ID (fingerprint
 * re-checked against state, rule 4), compute his current-epoch route tag and
 * the conversation id, assemble + encrypt a CempPayloadV1 text message,
 * publish it as a sender-owned message cell (rule 9) and record the mapping.
 */

export const SEND_TEXT = "hello bob — cemp reference client";

interface SendPending extends Record<string, unknown> {
  messageId: string;
  routeTag: string;
  conversationId: string;
  capacity: string;
  fee: string;
}

export const stepSend: StepFn = async (ctx, log) => {
  if (ctx.shared.steps.send === true) {
    log(`send already complete (checkpoint): tx ${ctx.shared.messages.aliceToBob?.txHash ?? "?"}`);
    return;
  }
  const alice = ctx.identities.alice;
  const bobRecord = ctx.shared.profiles.bob;
  const aliceRecord = ctx.shared.profiles.alice;
  if (bobRecord === null || aliceRecord === null) {
    throw new StepFailure("profiles missing — run the profiles step first");
  }

  // Resolve Bob's profile cell by Type ID via the indexer and re-check the
  // fingerprint against what we recorded at creation (rule 4).
  const resolved = await resolveLiveProfile(ctx.client, bobRecord.profileId);
  checkProfileFingerprint(resolved, bobRecord);
  log(`resolved bob profile cell ${resolved.cell.outPoint.txHash}:${resolved.cell.outPoint.index}`);

  const aliceProfileId = codec.hexToBytes(aliceRecord.profileId);
  const bobProfileId = codec.hexToBytes(bobRecord.profileId);
  const message = assembleTextMessage({
    text: SEND_TEXT,
    senderProfileId: aliceProfileId,
    recipientProfileId: bobProfileId,
    recipientKemPublicKey: resolved.profile.ml_kem_public_key,
    senderDeviceId: codec.hexToBytes(alice.state.deviceId),
    receiptRequest: 0x01, // want a "downloaded" receipt
  });
  log(
    `assembled message ${codec.bytesToHex(message.messageId)} ` +
      `(route epoch ${currentRoutingEpoch()}, conversation ${codec.bytesToHex(message.conversationId).slice(0, 16)}…)`,
  );

  const typeRef = cempMessageTypeRef(ctx);
  const result = await broadcastAndCheckpoint<SendPending>(
    ctx,
    "send",
    log,
    async () => {
      const built = await buildSendMessageTx({
        envelopeBytes: message.envelopeBytes,
        routeTag: message.routeTag,
        conversationTag: message.conversationTag,
        messageNonce: message.messageNonce,
        sender: alice.signer,
        cempMessageType: typeRef,
      });
      const capacity = built.tx.outputs[0]!.capacity;
      log(`message cell: capacity ${formatCkb(capacity)} CKB, lock = alice (sender-owned, rule 9)`);
      return {
        built,
        signer: alice.signer,
        metadata: {
          direction: "alice→bob",
          messageId: codec.bytesToHex(message.messageId),
          conversationId: codec.bytesToHex(message.conversationId),
          routeTag: codec.bytesToHex(message.routeTag),
          messageNonce: codec.bytesToHex(message.messageNonce),
          recipientProfileId: bobRecord.profileId,
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
        from: "alice",
        to: "bob",
        txHash: committed.txHash,
        outPoint: { txHash: committed.txHash, index: "0x0" },
        routeTag: committed.routeTag,
        conversationId: committed.conversationId,
        capacity: committed.capacity,
        fee: committed.fee,
      };
      ctx.shared.messages.aliceToBob = mapping;
      alice.state.messages.push({
        messageId: committed.messageId,
        direction: "sent",
        peerProfileId: bobRecord.profileId,
        txHash: committed.txHash,
        outPoint: mapping.outPoint,
        status: "published",
        recordedAt: new Date().toISOString(),
      });
      alice.state.fees.send = committed.fee;
      ctx.save();
    },
  );
  if (!result.skipped) {
    log(`send complete: ${result.txHash}`);
  }
};
