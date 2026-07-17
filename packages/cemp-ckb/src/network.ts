import { CKB_TESTNET } from "@cemp/core";
import type { CellDepRef, NetworkConfig } from "@cemp/core";
import type { HashType } from "./types.js";

/**
 * Network wiring for the CKB layer. The canonical network configuration lives
 * in `@cemp/core` (AGENTS.md: endpoints and deployed contract hashes are never
 * hard-coded in feature code); this module re-exports it and derives the
 * script references the transaction layer needs.
 */

export { CKB_TESTNET };
export type { CellDepRef, NetworkConfig, NetworkEndpoints } from "@cemp/core";

/** `{codeHash, hashType}` pair identifying a deployed script (no args). */
export interface ScriptTypeRef {
  codeHash: string;
  hashType: HashType;
}

/**
 * The deployed ML-DSA-65 v2 lock cell dep for a network. Throws when the
 * network has no pinned deployment — mainnet stays disabled until the
 * readiness gate passes (AGENTS.md rule 12), so callers must not paper over
 * a missing deployment.
 */
export function getMlDsaLockDeployment(network: NetworkConfig): CellDepRef {
  const deployment = network.deployments.mlDsaLock;
  if (deployment === null) {
    throw new Error(
      `network "${network.name}" has no pinned ML-DSA lock deployment (AGENTS.md rule 12)`,
    );
  }
  return deployment;
}

/**
 * The CEMP message type script for a network, or null when the contract is
 * not deployed yet (spec §6: the args layout is the discovery contract even
 * before a dedicated type script enforces it). Null today; the deploy task
 * fills the network config.
 */
export function getCempMessageTypeScript(network: NetworkConfig): ScriptTypeRef | null {
  const deployment = network.deployments.cempMessageType;
  if (deployment === null) {
    return null;
  }
  return { codeHash: deployment.codeHash, hashType: deployment.hashType };
}
