import { codec } from "@cemp/core";
import { randomBytes } from "@cemp/crypto";
import { buildReclaimTx } from "@cemp/ckb";
import { StepFailure, broadcastAndCheckpoint, cempMessageTypeRef } from "./shared.js";
import type { StepFn } from "./shared.js";
import { scanAndDecrypt } from "./discover.js";
import type { MessageRecord } from "../state.js";

/**
 * ack-reclaim — Alice discovers Bob's response under HER route tag, decrypts
 * and prints it, verifies it acknowledges her original message
 * (reply_to_outpoint match + downloaded receipt), marks the original
 * acknowledged, then reclaims the original message cell (sender-owned,
 * rule 9): capacity consolidates back to her lock. A ReclaimGroupV1 record
 * (spec §10) goes into the pre-broadcast journal metadata.
 */

interface ReclaimPending extends Record<string, unknown> {
  reclaimedOutpoint: string;
  reclaimedCapacity: string;
  fee: string;
}

export const stepAckReclaim: StepFn = async (ctx, log) => {
  const alice = ctx.identities.alice;
  if (ctx.shared.steps["ack-reclaim"] === true) {
    log(`ack-reclaim already complete (checkpoint): ${alice.state.fees["ack-reclaim"] ?? ""}`);
    return;
  }
  const original = ctx.shared.messages.aliceToBob;
  const response = ctx.shared.messages.bobToAlice;
  if (original === null || response === null) {
    throw new StepFailure("message mappings missing — run send/receive/respond first");
  }

  // 1. Discover + decrypt the response (idempotent; skips processed cells).
  const aliceRecord = ctx.shared.profiles.alice;
  const bobRecord = ctx.shared.profiles.bob;
  if (aliceRecord === null || bobRecord === null) {
    throw new StepFailure("profiles missing — run the profiles step first");
  }
  let verified = isAcknowledged(alice.state.messages, original.messageId);
  if (!verified) {
    const found = await scanAndDecrypt(ctx, alice, log, (msg) => {
      const messageId = codec.bytesToHex(msg.header.message_id);
      log(`decrypted message ${messageId} at ${msg.outPoint.txHash}:${msg.outPoint.index}:`);
      log(`  text: ${msg.text ?? "(none)"}`);
      alice.state.messages.push({
        messageId,
        direction: "received",
        peerProfileId: codec.bytesToHex(msg.header.sender_profile_id),
        txHash: msg.outPoint.txHash,
        outPoint: msg.outPoint,
        status: "received",
        recordedAt: new Date().toISOString(),
      });
    });
    const candidate = found.find(
      (msg) => codec.bytesToHex(msg.header.message_id) === response.messageId,
    );
    if (candidate === undefined) {
      throw new StepFailure(
        `bob's response ${response.messageId} was not discovered under alice's route tag — re-run the step`,
      );
    }
    verifyAcknowledgement(candidate.payload, original.messageId, original.outPoint);
    markMessage(alice.state.messages, original.messageId, "acknowledged");
    ctx.save();
    log(`alice's message ${original.messageId} is acknowledged by bob's response`);
    verified = true;
  }
  if (!verified) {
    throw new StepFailure("internal: acknowledgement verification fell through");
  }

  // 2. Reclaim the original message cell (capacity returns to alice's lock).
  const live = await ctx.client.getLiveCell(original.outPoint);
  if (live.status !== "live") {
    throw new StepFailure(
      `original message cell ${original.outPoint.txHash}:${original.outPoint.index} is ` +
        `${live.status} but no reclaim checkpoint exists — cannot reconstruct; inspect the state dir`,
    );
  }
  const typeRef = cempMessageTypeRef(ctx);
  const reclaimGroupHex = codec.bytesToHex(
    codec.encodeReclaimGroupV1({
      reclaim_group_id: randomBytes(16),
      reason: 0x01, // acknowledged (spec §10)
      created_at: BigInt(Math.floor(Date.now() / 1000)),
      outpoints: [
        {
          tx_hash: codec.hexToBytes(original.outPoint.txHash.slice(2)),
          index: Number(BigInt(original.outPoint.index)),
        },
      ],
    }),
  );
  const result = await broadcastAndCheckpoint<ReclaimPending>(
    ctx,
    "ack-reclaim",
    log,
    async () => {
      const built = await buildReclaimTx({
        outpoints: [original.outPoint],
        resolvedCells: [live.cell],
        signer: alice.signer,
        messageTypeCellDep: typeRef.cellDep,
      });
      return {
        built,
        signer: alice.signer,
        metadata: {
          action: "reclaim original message cell (acknowledged)",
          reclaimedOutpoint: `${original.outPoint.txHash}:${original.outPoint.index}`,
          reclaimedCapacity: live.cell.output.capacity,
          reclaimGroupV1: reclaimGroupHex,
        },
        pendingData: {
          reclaimedOutpoint: `${original.outPoint.txHash}:${original.outPoint.index}`,
          reclaimedCapacity: BigInt(live.cell.output.capacity).toString(),
          fee: built.estimatedFee.toString(),
        },
      };
    },
    (committed) => {
      markMessage(alice.state.messages, original.messageId, "reclaimed");
      alice.state.fees["ack-reclaim"] = committed.fee;
      ctx.save();
      log(
        `reclaimed ${committed.reclaimedOutpoint}: ${committed.reclaimedCapacity} shannons ` +
          "(minus fee) returned to alice's lock",
      );
    },
  );
  if (!result.skipped) {
    log(`ack-reclaim complete: ${result.txHash}`);
  }
};

function isAcknowledged(messages: MessageRecord[], messageId: string): boolean {
  const record = messages.find((m) => m.direction === "sent" && m.messageId === messageId);
  return (
    record !== undefined && (record.status === "acknowledged" || record.status === "reclaimed")
  );
}

function markMessage(
  messages: MessageRecord[],
  messageId: string,
  status: "acknowledged" | "reclaimed",
): void {
  const record = messages.find((m) => m.messageId === messageId);
  if (record === undefined) {
    throw new StepFailure(`internal: no local record of message ${messageId}`);
  }
  record.status = status;
}

/** reply_to_outpoint match + a downloaded receipt for the original message (spec §9). */
function verifyAcknowledgement(
  payload: codec.CempPayloadV1,
  originalMessageId: string,
  originalOutPoint: { txHash: string; index: string },
): void {
  const reply = payload.reply_to_outpoint;
  if (
    reply === undefined ||
    codec.bytesToHex(reply.tx_hash) !== originalOutPoint.txHash.slice(2) ||
    BigInt(reply.index) !== BigInt(originalOutPoint.index)
  ) {
    throw new StepFailure(
      "response reply_to_outpoint does not match alice's original message cell",
    );
  }
  if (
    payload.reply_to_message_id === undefined ||
    codec.bytesToHex(payload.reply_to_message_id) !== originalMessageId
  ) {
    throw new StepFailure("response reply_to_message_id does not match the original message");
  }
  const receipt = payload.receipts.find(
    (entry) => codec.bytesToHex(entry.message_id) === originalMessageId,
  );
  if (receipt === undefined || receipt.status !== 0x01) {
    throw new StepFailure("response carries no downloaded receipt for the original message");
  }
}
