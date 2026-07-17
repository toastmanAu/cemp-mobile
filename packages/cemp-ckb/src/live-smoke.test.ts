import { describe, expect, it } from "vitest";
import { CempClient } from "./client.js";

/**
 * Live testnet smoke test — READ-ONLY (tip header + indexer queries). Skipped
 * unless CEMP_LIVE_TESTNET=1. Nothing here builds, signs or broadcasts a
 * transaction.
 *
 * The prefix-mode probe works by comparing `exact` and `prefix` searches
 * over a one-byte args value against the well-known secp256k1 lock:
 *  - prefix must return at least one cell whose args are LONGER than the
 *    query (proof that prefix matching happened), and
 *  - exact must return only cells whose args equal the query byte-for-byte.
 */

const LIVE = process.env.CEMP_LIVE_TESTNET === "1";

/** Well-known secp256k1-blake160 code hash (identical on testnet/mainnet). */
const SECP256K1_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

describe.skipIf(!LIVE)("live testnet smoke (read-only)", () => {
  it(
    "fetches the tip header, runs an indexer query, and probes args-prefix support",
    { timeout: 60_000 },
    async () => {
      const client = new CempClient();

      const tip = await client.getTipHeader();
      expect(BigInt(tip.number) > 0n).toBe(true);

      const script = { codeHash: SECP256K1_CODE_HASH, hashType: "type" as const, args: "0x00" };
      const prefixPage = await client.findCells({
        script,
        scriptType: "lock",
        argsSearchMode: "prefix",
        limit: 10,
      });
      expect(prefixPage.cells.length).toBeGreaterThan(0);

      const exactPage = await client.findCells({
        script,
        scriptType: "lock",
        argsSearchMode: "exact",
        limit: 10,
      });

      const prefixWidened = prefixPage.cells.some(
        (cell) => cell.output.lock.args.length > "0x00".length,
      );
      const exactIsExact = exactPage.cells.every((cell) => cell.output.lock.args === "0x00");
      const prefixSupported = prefixWidened && exactIsExact;

      console.log(
        `[live-smoke] tip=${tip.number} prefixCells=${prefixPage.cells.length} ` +
          `exactCells=${exactPage.cells.length} prefixWidened=${prefixWidened} ` +
          `exactIsExact=${exactIsExact} → script_search_mode "prefix" supported: ${prefixSupported}`,
      );
      expect(prefixSupported).toBe(true);
    },
  );
});
