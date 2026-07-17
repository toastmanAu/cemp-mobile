import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute path of apps/reference-client (this file is src/paths.ts). */
export const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Monorepo root (apps/reference-client → apps → root). */
export const REPO_ROOT = path.resolve(APP_DIR, "..", "..");

/** Compiled CEMP message type script binary (contracts/ workspace output). */
export const CONTRACT_BINARY_PATH = path.join(
  REPO_ROOT,
  "contracts",
  "target",
  "riscv64imac-unknown-none-elf",
  "release",
  "cemp-message-type",
);

/** contracts/cemp-message-type/build.sh — run when the binary is missing. */
export const CONTRACT_BUILD_SCRIPT = path.join(
  REPO_ROOT,
  "contracts",
  "cemp-message-type",
  "build.sh",
);

/** Deployment record written by the deploy-type step. */
export const DEPLOYMENT_RECORD_PATH = path.join(
  REPO_ROOT,
  "contracts",
  "deployment",
  "cemp-message-type.testnet.json",
);

/** Network configuration updated by the deploy-type step (never hard-code deployments). */
export const NETWORK_CONFIG_PATH = path.join(
  REPO_ROOT,
  "packages",
  "cemp-core",
  "src",
  "network.ts",
);
