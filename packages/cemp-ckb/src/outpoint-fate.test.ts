import { describe, expect, it } from "vitest";

import { SPENT_CONFIRMATION_DEPTH, resolveOutPointFate, type FateClient } from "./outpoint-fate.js";
import type { Cell, LiveCellStatus, OutPoint, Transaction, TransactionStatus } from "./types.js";

const TX = `0x${"ab".repeat(32)}`;
const OUT: OutPoint = { txHash: TX, index: "0x1" };
const TIP = 23_191_200;

/**
 * A fake node whose answers can be set per test. Defaults mirror the REAL
 * testnet node observed 2026-11-26: a spent cell is reported `unknown`,
 * never `dead`, while its creating tx is still `committed`.
 */
function fakeNode(opts: {
  live?: LiveCellStatus["status"];
  /** Answers for successive get_live_cell calls (overrides `live`). */
  liveSeq?: LiveCellStatus["status"][];
  throwOn?: "getTransaction" | "getTipHeader" | "getTransactionBody";
  txStatus?: TransactionStatus["status"];
  createdAt?: number;
  outputs?: number;
}): FateClient {
  let call = 0;
  const boom = (name: string) => {
    if (opts.throwOn === name) throw new Error(`rpc ${name} failed`);
  };
  return {
    getLiveCell: (outPoint) => {
      const live = opts.liveSeq?.[call++] ?? opts.live ?? "unknown";
      return Promise.resolve(
        live === "live"
          ? { status: "live", cell: { outPoint } as unknown as Cell }
          : ({ status: live, outPoint } as LiveCellStatus),
      );
    },
    getTransaction: (hash) => {
      boom("getTransaction");
      const s = opts.txStatus ?? "committed";
      return Promise.resolve(
        s === "committed"
          ? {
              status: "committed",
              txHash: hash,
              blockHash: `0x${"cd".repeat(32)}`,
              blockNumber: `0x${(opts.createdAt ?? TIP - 1000).toString(16)}`,
            }
          : ({ status: s, txHash: hash } as TransactionStatus),
      );
    },
    getTransactionBody: () => {
      boom("getTransactionBody");
      return Promise.resolve({
        outputs: Array.from({ length: opts.outputs ?? 2 }, () => ({})),
      } as unknown as Transaction);
    },
    getTipHeader: () => {
      boom("getTipHeader");
      return Promise.resolve({
        number: `0x${TIP.toString(16)}`,
        epoch: "0x0",
        timestamp: "0x0",
        hash: `0x${"ef".repeat(32)}`,
      });
    },
  };
}

describe("resolveOutPointFate", () => {
  it("live is live, carrying the cell", async () => {
    const fate = await resolveOutPointFate(fakeNode({ live: "live" }), OUT);
    expect(fate.fate).toBe("live");
  });

  it("an explicit dead is spent", async () => {
    expect((await resolveOutPointFate(fakeNode({ live: "dead" }), OUT)).fate).toBe("spent");
  });

  it("REAL NODE: unknown + creating tx committed deep + index in range is spent", async () => {
    // Exactly what testnet answered for a spent message cell on 2026-11-26.
    expect((await resolveOutPointFate(fakeNode({}), OUT)).fate).toBe("spent");
  });

  it("is spent at exactly the confirmation depth", async () => {
    const node = fakeNode({ createdAt: TIP - SPENT_CONFIRMATION_DEPTH });
    expect((await resolveOutPointFate(node, OUT)).fate).toBe("spent");
  });

  it("a creating tx shallower than the depth stays unknown (node lag)", async () => {
    const node = fakeNode({ createdAt: TIP - SPENT_CONFIRMATION_DEPTH + 1 });
    expect((await resolveOutPointFate(node, OUT)).fate).toBe("unknown");
  });

  it("an unknown creating tx stays unknown (never existed, or node behind)", async () => {
    expect((await resolveOutPointFate(fakeNode({ txStatus: "unknown" }), OUT)).fate).toBe(
      "unknown",
    );
  });

  it("a pending creating tx stays unknown", async () => {
    expect((await resolveOutPointFate(fakeNode({ txStatus: "pending" }), OUT)).fate).toBe(
      "unknown",
    );
  });

  it("an index past the creating tx's outputs stays unknown (no such cell)", async () => {
    expect((await resolveOutPointFate(fakeNode({ outputs: 1 }), OUT)).fate).toBe("unknown");
  });

  it("the depth is a few minutes of blocks, not hours", () => {
    expect(SPENT_CONFIRMATION_DEPTH).toBeGreaterThanOrEqual(12);
    expect(SPENT_CONFIRMATION_DEPTH).toBeLessThanOrEqual(100);
  });

  it.each(["getTransaction", "getTipHeader", "getTransactionBody"] as const)(
    "a node error in %s yields unknown and never throws (one bad row cannot block a batch)",
    async (throwOn) => {
      expect((await resolveOutPointFate(fakeNode({ throwOn }), OUT)).fate).toBe("unknown");
    },
  );

  it("a cell that reads live on the re-check is live (lagging backend behind a load balancer)", async () => {
    const fate = await resolveOutPointFate(fakeNode({ liveSeq: ["unknown", "live"] }), OUT);
    expect(fate.fate).toBe("live");
  });
});
