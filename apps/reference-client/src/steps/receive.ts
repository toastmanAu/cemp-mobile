import { codec } from "@cemp/core";
import { StepFailure } from "./shared.js";
import type { StepFn } from "./shared.js";
import { scanAndDecrypt } from "./discover.js";

/**
 * receive — Bob scans his route-tag prefix (current + previous epoch),
 * validates + decrypts every unknown message cell, runs semantic consistency
 * against his own profile id, prints the plaintext to stdout (stdout only,
 * rule 3) and records receipt-eligible messages in his local history.
 */
export const stepReceive: StepFn = async (ctx, log) => {
  const bob = ctx.identities.bob;
  if (ctx.shared.steps.receive === true) {
    log("receive already complete (checkpoint) — recorded messages:");
    for (const record of bob.state.messages) {
      log(`  ${record.direction} ${record.messageId} [${record.status}]`);
    }
    return;
  }
  const expected = ctx.shared.messages.aliceToBob;
  if (expected === null) {
    throw new StepFailure("no alice→bob message mapping — run the send step first");
  }
  const bobRecord = ctx.shared.profiles.bob;
  if (bobRecord === null) {
    throw new StepFailure("bob has no profile — run the profiles step first");
  }

  const found = await scanAndDecrypt(ctx, bob, log, (msg) => {
    const messageId = codec.bytesToHex(msg.header.message_id);
    log(`decrypted message ${messageId} at ${msg.outPoint.txHash}:${msg.outPoint.index}:`);
    log(`  text: ${msg.text ?? "(none)"}`);
    bob.state.messages.push({
      messageId,
      direction: "received",
      peerProfileId: codec.bytesToHex(msg.header.sender_profile_id),
      txHash: msg.outPoint.txHash,
      outPoint: msg.outPoint,
      status: "received",
      recordedAt: new Date().toISOString(),
    });
  });

  const gotExpected = found.some(
    (msg) => codec.bytesToHex(msg.header.message_id) === expected.messageId,
  );
  if (!gotExpected) {
    throw new StepFailure(
      `alice's message ${expected.messageId} was not discovered under bob's route tag ` +
        "(indexer lag or wrong prefix) — re-run the receive step",
    );
  }
  ctx.shared.steps.receive = true;
  ctx.save();
  log(`receive complete: ${found.length} message(s) decrypted and recorded (receipt-eligible).`);
};
