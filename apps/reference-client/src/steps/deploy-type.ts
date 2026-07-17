import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { hashCkb } from "@ckb-ccc/core";
import { buildDeployDataCellTx } from "@cemp/ckb";
import {
  CONTRACT_BINARY_PATH,
  CONTRACT_BUILD_SCRIPT,
  DEPLOYMENT_RECORD_PATH,
  NETWORK_CONFIG_PATH,
} from "../paths.js";
import { StepFailure, broadcastAndCheckpoint, formatCkb } from "./shared.js";
import type { StepFn } from "./shared.js";
import type { DeploymentRecord } from "../state.js";

/**
 * deploy-type — publish the cemp-message-type contract binary as a `data1`
 * code cell (Alice doubles as the deployer), then record the deployment:
 *
 *   1. build the binary via contracts/cemp-message-type/build.sh if missing;
 *   2. recompute blake2b-256(ckb-default-hash) of the binary and REQUIRE it
 *      to match the reference codeHash before broadcasting;
 *   3. build (one data cell, Alice's lock, NO type script) → journal → sign
 *      → broadcast → wait for commit;
 *   4. write contracts/deployment/cemp-message-type.testnet.json and update
 *      `deployments.cempMessageType` in packages/cemp-core/src/network.ts.
 *
 * The cell's capacity is its occupied size + margin and stays locked
 * PERMANENTLY (~3,127 CKB one-time cost for the 3,048-byte binary —
 * occupied capacity is 1 CKB per on-chain byte; it is the code cell every
 * future message transaction references through cell deps).
 */

// blake2b-256 (ckb-default-hash) of contracts/target/…/release/cemp-message-type.
// v2 of the binary: raw-syscall entry without ckb-gen-types/bytes — the first
// build (0xb0d8497f…0a0a) died on-chain with VM InvalidInstruction because
// bytes::Bytes refcount clones compile to A-extension atomics CKB-VM lacks.
const EXPECTED_CODE_HASH = "0xd172d3bfb46d2e2f8f0e1c24139d3851010776205d66cec235dca34ec52234b8";

interface DeployPending extends Record<string, unknown> {
  codeHash: string;
  capacity: string;
  fee: string;
  binaryBytes: number;
}

export const stepDeployType: StepFn = async (ctx, log) => {
  if (ctx.shared.steps["deploy-type"] === true) {
    const record = ctx.shared.deployment;
    log(`deploy-type already complete (checkpoint): tx ${record?.deployTxHash ?? "?"}`);
    syncNetworkConfig(record, log);
    return;
  }

  if (!fs.existsSync(CONTRACT_BINARY_PATH)) {
    log(`contract binary missing — running ${CONTRACT_BUILD_SCRIPT}`);
    try {
      execFileSync("bash", [CONTRACT_BUILD_SCRIPT], { stdio: "inherit" });
    } catch (err) {
      throw new StepFailure(
        `contract build failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const binary = fs.readFileSync(CONTRACT_BINARY_PATH);
  const codeHash = hashCkb(binary);
  log(`contract binary: ${binary.length} bytes, codeHash ${codeHash}`);
  if (codeHash !== EXPECTED_CODE_HASH) {
    throw new StepFailure(
      `binary codeHash ${codeHash} does not match the expected ${EXPECTED_CODE_HASH} — ` +
        "refusing to deploy (rebuild with the pinned toolchain; see contracts/cemp-message-type/README.md)",
    );
  }

  const result = await broadcastAndCheckpoint<DeployPending>(
    ctx,
    "deploy-type",
    log,
    async () => {
      const built = await buildDeployDataCellTx({
        data: binary,
        signer: ctx.identities.alice.signer,
      });
      const capacity = built.tx.outputs[0]!.capacity;
      log(
        `contract cell capacity: ${formatCkb(capacity)} CKB (occupied ${formatCkb(capacity - 100_000_000n)} + margin) — locked permanently`,
      );
      return {
        built,
        signer: ctx.identities.alice.signer,
        metadata: {
          contract: "cemp-message-type",
          codeHash,
          hashType: "data1",
          binaryBytes: binary.length,
          capacity: capacity.toString(),
        },
        pendingData: {
          codeHash,
          capacity: capacity.toString(),
          fee: built.estimatedFee.toString(),
          binaryBytes: binary.length,
        },
      };
    },
    (committed) => {
      const record: DeploymentRecord = {
        network: "ckb_testnet",
        contract: "cemp-message-type",
        version: "0.1.0",
        deployTxHash: committed.txHash,
        outPointIndex: 0,
        codeHash: committed.codeHash,
        hashType: "data1",
        deployedAt: new Date().toISOString().slice(0, 10),
        sourceCommit: gitHead(),
        notes:
          "Deployed by apps/reference-client (deploy-type step). hashType data1: immutable " +
          "code reference, no TYPE ID upgrade path. Capacity locked permanently in the code cell.",
      };
      ctx.shared.deployment = record;
      ctx.shared.contractCellCapacity = committed.capacity;
      ctx.identities.alice.state.fees["deploy-type"] = committed.fee;
      ctx.save();
      writeDeploymentRecord(record, log);
      syncNetworkConfig(record, log);
    },
  );
  if (!result.skipped) {
    log(`deploy-type complete: ${result.txHash}`);
  }
};

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function writeDeploymentRecord(record: DeploymentRecord, log: (m: string) => void): void {
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (fs.existsSync(DEPLOYMENT_RECORD_PATH)) {
    const existing = fs.readFileSync(DEPLOYMENT_RECORD_PATH, "utf8");
    if (existing === json) {
      return;
    }
  }
  fs.writeFileSync(DEPLOYMENT_RECORD_PATH, json, "utf8");
  log(`wrote ${DEPLOYMENT_RECORD_PATH}`);
}

/**
 * Update `deployments.cempMessageType` in packages/cemp-core/src/network.ts
 * (AGENTS.md: deployed contract identifiers live in network configuration).
 * Idempotent; refuses to clobber a different deployment.
 */
function syncNetworkConfig(record: DeploymentRecord | null, log: (m: string) => void): void {
  if (record === null) {
    return;
  }
  const source = fs.readFileSync(NETWORK_CONFIG_PATH, "utf8");
  if (source.includes(record.deployTxHash)) {
    return; // already synced
  }
  const marker = "cempMessageType: null,";
  if (!source.includes(marker)) {
    throw new StepFailure(
      `${NETWORK_CONFIG_PATH} contains neither the recorded deployment nor the ` +
        "`cempMessageType: null` placeholder — refusing to edit it programmatically",
    );
  }
  const replacement =
    `cempMessageType: {\n` +
    `      txHash: "${record.deployTxHash}",\n` +
    `      index: ${record.outPointIndex},\n` +
    `      depType: "code",\n` +
    `      codeHash: "${record.codeHash}",\n` +
    `      hashType: "data1",\n` +
    `    },`;
  const comment = /[ \t]*\/\/ Not deployed yet[^\n]*\n/;
  const updated = source.replace(comment, "").replace(marker, replacement);
  if (updated === source || !updated.includes(record.deployTxHash)) {
    throw new StepFailure(`failed to update ${NETWORK_CONFIG_PATH} programmatically`);
  }
  fs.writeFileSync(NETWORK_CONFIG_PATH, updated, "utf8");
  log(`updated deployments.cempMessageType in ${NETWORK_CONFIG_PATH}`);
}
