/**
 * One-off recovery (2026-07-17): reclaim the FIRST cemp-message-type code
 * cell. That binary (codeHash 0xb0d8497f…0a0a) contained RISC-V A-extension
 * atomics via ckb-gen-types/bytes refcount clones; CKB-VM has no A extension,
 * so the `send` step died on-chain with `VM Internal Error:
 * InvalidInstruction`. The contract was rewritten to a raw-syscall entry
 * (contracts/cemp-message-type/src/main.rs) and this script:
 *
 *   1. spends the broken code cell back to alice (journal → sign → broadcast,
 *      rule 6 like every other transaction);
 *   2. resets the deploy-type checkpoint / deployment record so a `run`
 *      re-executes deploy-type with the fixed binary;
 *   3. restores `deployments.cempMessageType: null` in
 *      packages/cemp-core/src/network.ts for the redeploy to fill in.
 *
 * Run from apps/reference-client:  npx tsx recover-broken-deploy.ts
 */
import { Transaction } from "@ckb-ccc/core";
import { CKB_TESTNET } from "@cemp/core";
import { CempClient, DEFAULT_FEE_RATE, MlDsaV2TxSigner, clientCellResolver } from "@cemp/ckb";
import fs from "node:fs";
import { waitForCommit } from "./src/chain.js";
import { deriveIdentity } from "./src/identities.js";
import { writeJournal } from "./src/journal.js";
import { NETWORK_CONFIG_PATH } from "./src/paths.js";
import { cccTxToWire } from "./src/wire.js";

const STATE_DIR = "./.cemp-state";

/** The broken first deployment (deploy-type run at block 21,777,832). */
const BROKEN_CELL = {
  txHash: "0x78581966c7d469d34ffdf4dac8cf7c993f2f6dba61e20335f558e66316c49647",
  index: "0x0",
} as const;

async function main(): Promise<void> {
  const client = new CempClient();
  const signer = MlDsaV2TxSigner.fromIdentityKeys(deriveIdentity("alice"), client.ccc, CKB_TESTNET);

  const status = await client.getLiveCell({ txHash: BROKEN_CELL.txHash, index: BROKEN_CELL.index });
  if (status.status !== "live") {
    console.log(`broken cell is ${status.status} — nothing to reclaim`);
  } else {
    const capacity = BigInt(status.cell.output.capacity);
    console.log(`reclaiming broken code cell: ${capacity / 100_000_000n} CKB`);

    const tx = Transaction.from({
      inputs: [{ previousOutput: { txHash: BROKEN_CELL.txHash, index: 0 }, since: 0 }],
      outputs: [],
      outputsData: [],
    });
    await tx.completeFeeChangeToLock(signer, signer.lockScript(), DEFAULT_FEE_RATE);
    const fee = await tx.getFee(client.ccc);

    // Rule 6: journal the unsigned transaction BEFORE signing/broadcast.
    const journalPath = writeJournal(`${STATE_DIR}/journal`, {
      label: "reclaim-broken-deploy",
      createdAt: new Date().toISOString(),
      network: client.network.name,
      unsignedTx: cccTxToWire(tx),
      resolvedInputs: [
        { txHash: BROKEN_CELL.txHash, index: BROKEN_CELL.index, capacity: capacity.toString() },
      ],
      estimatedFee: fee.toString(),
      metadata: {
        reason:
          "first cemp-message-type binary carried A-extension instructions " +
          "(ckb-gen-types/bytes atomics) that CKB-VM cannot execute — reclaiming " +
          "the broken code cell before redeploying the fixed binary",
        brokenCodeHash: "0xb0d8497f78c22610d0c02a77235046ed62a006f6bce67b18fb18c5330aff0a0a",
      },
    });
    console.log(`journaled unsigned tx → ${journalPath}`);

    const signed = await signer.signTransaction(tx);
    const resolver = clientCellResolver(client.ccc);
    const resolved = [];
    for (const input of signed.inputs) {
      const cell = await resolver.resolve(input.previousOutput);
      if (cell === undefined) {
        throw new Error(`input ${input.previousOutput.txHash} is not live`);
      }
      resolved.push(cell);
    }
    if (!signer.verifyOwnSignature(signed, resolved)) {
      throw new Error("self-verification failed — not broadcasting");
    }
    const txHash = await client.sendTransaction(cccTxToWire(signed));
    console.log(`broadcast accepted: ${txHash}`);
    await waitForCommit(client, txHash, console.log);

    // Record the recovery fee under alice (reconcile counts every fee).
    const alicePath = `${STATE_DIR}/alice.json`;
    const alice = JSON.parse(fs.readFileSync(alicePath, "utf8")) as {
      fees: Record<string, string>;
    };
    alice.fees["reclaim-broken-deploy"] = fee.toString();
    fs.writeFileSync(alicePath, `${JSON.stringify(alice, null, 2)}\n`, "utf8");
    console.log(`recorded reclaim fee ${fee} shannons`);
  }

  // Keep the first deploy's fee visible under a distinct key so reconcile
  // still counts it; the rerun deploy-type records its own fee.
  const alicePath = `${STATE_DIR}/alice.json`;
  const alice = JSON.parse(fs.readFileSync(alicePath, "utf8")) as {
    fees: Record<string, string>;
  };
  if (alice.fees["deploy-type"] !== undefined) {
    alice.fees["deploy-type.v1-broken"] = alice.fees["deploy-type"];
    delete alice.fees["deploy-type"];
    fs.writeFileSync(alicePath, `${JSON.stringify(alice, null, 2)}\n`, "utf8");
  }

  // Reset the deploy-type checkpoint so `run` redeploys the fixed binary.
  const sharedPath = `${STATE_DIR}/shared.json`;
  const shared = JSON.parse(fs.readFileSync(sharedPath, "utf8")) as {
    steps: Record<string, boolean>;
    deployment: unknown;
    contractCellCapacity: unknown;
  };
  delete shared.steps["deploy-type"];
  shared.deployment = null;
  shared.contractCellCapacity = null;
  fs.writeFileSync(sharedPath, `${JSON.stringify(shared, null, 2)}\n`, "utf8");
  console.log("deploy-type checkpoint reset");

  // Restore the null placeholder so the redeploy can fill it in.
  const source = fs.readFileSync(NETWORK_CONFIG_PATH, "utf8");
  const block =
    / {4}cempMessageType: \{\n {6}txHash: "0x78581966c7d469d34ffdf4dac8cf7c993f2f6dba61e20335f558e66316c49647",\n {6}index: 0,\n {6}depType: "code",\n {6}codeHash: "0xb0d8497f78c22610d0c02a77235046ed62a006f6bce67b18fb18c5330aff0a0a",\n {6}hashType: "data1",\n {4}\},/;
  if (!block.test(source)) {
    throw new Error(`${NETWORK_CONFIG_PATH} does not contain the expected broken deployment block`);
  }
  fs.writeFileSync(
    NETWORK_CONFIG_PATH,
    source.replace(
      block,
      "    // Not deployed yet — contracts/cemp-message-type lands in a later phase.\n" +
        "    cempMessageType: null,",
    ),
    "utf8",
  );
  console.log(`restored cempMessageType: null in ${NETWORK_CONFIG_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
