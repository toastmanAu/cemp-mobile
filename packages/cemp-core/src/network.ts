/**
 * Network configuration (spec §13). Testnet and mainnet configuration are
 * structurally separate (AGENTS.md rule 11); never silently switch networks.
 */

export interface NetworkEndpoints {
  rpc: string;
  indexer: string;
}

export interface NetworkConfig {
  /** Chain identifier, e.g. "ckb_testnet". */
  name: string;
  isTestnet: boolean;
  /** Ordered list; first healthy endpoint wins, failures rotate (spec §13). */
  endpoints: NetworkEndpoints[];
  /** Deployed CEMP/ML-DSA contract identifiers — populated after testnet deploy. */
  deployments: ContractDeployments;
}

export interface ContractDeployments {
  /** ML-DSA-65 lock script cell dep, if pinned for this network. */
  mlDsaLock: CellDepRef | null;
  /** CEMP message type script cell dep, once deployed (contracts/cemp-message-type). */
  cempMessageType: CellDepRef | null;
}

export interface CellDepRef {
  txHash: string;
  index: number;
  depType: "code" | "depGroup";
  /** Expected code hash of the resolved cell, for verification. */
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
}

/**
 * Bundled public CKB testnet endpoints (spec §13). User-configurable RPC/indexer
 * endpoints are supported at runtime; this is only the default.
 */
export const CKB_TESTNET: NetworkConfig = {
  name: "ckb_testnet",
  isTestnet: true,
  endpoints: [{ rpc: "https://testnet.ckb.dev/rpc", indexer: "https://testnet.ckb.dev/indexer" }],
  deployments: {
    // Canonical testnet ML-DSA-65 lock: mldsa65-lock-v2-rust (v2 format,
    // 37-byte args, full CighashAll digest). Verified against the
    // ckb-mldsa-lock README — see docs/grounding/reference-projects.md §3.
    // Business logic must read this from config, never hard-code it (spec §3).
    mlDsaLock: {
      txHash: "0x1074b1ac79213c22b5e32a0fde44a858a47f9575c9f54006a1deb80d32070cb1",
      index: 3,
      depType: "code",
      codeHash: "0xd70653f7fd51e173ec506b76081f37bf4acebb8a15dc79e6d4ad43ca4d3b78a4",
      hashType: "type",
    },
    cempMessageType: {
      txHash: "0x25727f7670790089659f968c58ed8b3bc0d539d837fbf88dc010178b14f17aa5",
      index: 0,
      depType: "code",
      codeHash: "0xd172d3bfb46d2e2f8f0e1c24139d3851010776205d66cec235dca34ec52234b8",
      hashType: "data1",
    },
  },
};
