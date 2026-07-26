import { describe, expect, it } from "vitest";
import { CempClient, type JsonRpcTransport } from "./client.js";
import { JournaledAbandonedError, resumeJournaledBroadcast } from "./monitor.js";
import { fillHex } from "./testing/mock-ccc-client.js";

/**
 * Journaled-broadcast resume (review E1 + I-3): order-of-truth walks, and the
 * rule that only GENUINELY unlandable txs (rejected, inputs spent elsewhere,
 * no signed bytes) abandon — a transient rebroadcast failure must propagate
 * the original error so the caller retries instead of risking a double
 * commit by abandoning a tx that may still land.
 */

/** A minimal, shape-valid wire transaction (what the journal persists). */
const WIRE_TX = {
  version: "0x0",
  cellDeps: [],
  headerDeps: [],
  inputs: [{ previousOutput: { txHash: fillHex(0x11, 32), index: "0x0" }, since: "0x0" }],
  outputs: [],
  outputsData: [],
  witnesses: [],
};

const TX_HASH = fillHex(0xab, 32);

function makeClient(opts: {
  /** get_transaction responses in call order (last one repeats). */
  statuses: unknown[];
  sendError?: Error;
  /** send_transaction result (defaults to the journaled hash). */
  sendResult?: string;
}): { client: CempClient; sentBodies: unknown[] } {
  const sentBodies: unknown[] = [];
  let statusCalls = 0;
  const transport: JsonRpcTransport = {
    call(_url, method, params) {
      switch (method) {
        case "get_transaction": {
          const status = opts.statuses[Math.min(statusCalls, opts.statuses.length - 1)];
          statusCalls += 1;
          return Promise.resolve(status);
        }
        case "send_transaction":
          if (opts.sendError !== undefined) {
            return Promise.reject(opts.sendError);
          }
          sentBodies.push(params[0]);
          return Promise.resolve(opts.sendResult ?? TX_HASH);
        case "get_header":
          return Promise.resolve({
            number: "0x100",
            epoch: "0x0",
            timestamp: "0x0",
            hash: fillHex(0x99, 32),
          });
        default:
          return Promise.reject(new Error(`unexpected method ${method}`));
      }
    },
  };
  return { client: new CempClient({ transport }), sentBodies };
}

const committed = { tx_status: { status: "committed", block_hash: fillHex(0x99, 32) } };
const unknown = { tx_status: { status: "unknown" } };

describe("resumeJournaledBroadcast", () => {
  it("returns 'committed' when the journaled tx already landed", async () => {
    const { client } = makeClient({ statuses: [committed] });
    const outcome = await resumeJournaledBroadcast(client, {
      txHash: TX_HASH,
      txHex: JSON.stringify(WIRE_TX),
    });
    expect(outcome).toBe("committed");
  });

  it("abandons a journaled tx the network rejected", async () => {
    const { client } = makeClient({
      statuses: [{ tx_status: { status: "rejected", reason: "Resolve failed Unknown(OutPoint)" } }],
    });
    const failure = await resumeJournaledBroadcast(client, {
      txHash: TX_HASH,
      txHex: JSON.stringify(WIRE_TX),
    }).then(
      () => {
        throw new Error("expected abandonment");
      },
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(JournaledAbandonedError);
    expect((failure as JournaledAbandonedError).inputsSpentElsewhere).toBe(false);
  });

  it("abandons an unknown journaled tx when the journal holds no signed bytes", async () => {
    const { client } = makeClient({ statuses: [unknown] });
    await expect(
      resumeJournaledBroadcast(client, { txHash: TX_HASH, txHex: null }),
    ).rejects.toBeInstanceOf(JournaledAbandonedError);
  });

  it("rebroadcasts an unknown journaled tx from the journaled signed bytes", async () => {
    const { client, sentBodies } = makeClient({ statuses: [unknown, committed] });
    const outcome = await resumeJournaledBroadcast(client, {
      txHash: TX_HASH,
      txHex: JSON.stringify(WIRE_TX),
    });
    expect(outcome).toBe("rebroadcast");
    expect(sentBodies).toHaveLength(1);
  });

  it("rethrows a TRANSIENT rebroadcast failure as-is — no abandonment (I-3)", async () => {
    const { client } = makeClient({
      statuses: [unknown],
      sendError: new Error("PoolRejectedRBF: mempool is full"),
    });
    const failure = await resumeJournaledBroadcast(client, {
      txHash: TX_HASH,
      txHex: JSON.stringify(WIRE_TX),
    }).then(
      () => {
        throw new Error("expected the original error");
      },
      (e: unknown) => e,
    );
    // The ORIGINAL error propagates — the tx may still land, so the caller
    // must NOT abandon it (double-commit risk).
    expect(failure).not.toBeInstanceOf(JournaledAbandonedError);
    expect((failure as Error).message).toContain("mempool is full");
  });

  it("abandons when the rebroadcast fails because the inputs were spent elsewhere (I-3)", async () => {
    const { client } = makeClient({
      statuses: [unknown],
      sendError: new Error("Resolve failed Dead(OutPoint(0x1234))"),
    });
    const failure = await resumeJournaledBroadcast(client, {
      txHash: TX_HASH,
      txHex: JSON.stringify(WIRE_TX),
    }).then(
      () => {
        throw new Error("expected abandonment");
      },
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(JournaledAbandonedError);
    expect((failure as JournaledAbandonedError).inputsSpentElsewhere).toBe(true);
  });
});
