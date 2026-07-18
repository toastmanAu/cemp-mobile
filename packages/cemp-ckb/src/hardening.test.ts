import { describe, expect, it } from "vitest";
import {
  CempCkbError,
  parseCellsPage,
  parseLiveCellStatus,
  parseTransactionBody,
  parseTransactionStatus,
} from "./client.js";
import { parseMessageTypeArgs } from "./incoming.js";
import { RateLimiter } from "./rate-limit.js";
import type { OutPoint } from "./types.js";

/**
 * Phase 11 hardening battery (cemp-ckb): hostile indexer responses, rate
 * limits, type-args robustness. Rule 4: every parser is a boundary.
 */
function fill(byte: number, length: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(length)}`;
}

describe("hostile indexer/RPC responses (tasks 3–4)", () => {
  it("parseCellsPage rejects malformed shapes", () => {
    expect(() => parseCellsPage(null)).toThrow(CempCkbError);
    expect(() => parseCellsPage({ objects: "not-an-array", last_cursor: "0x0" })).toThrow(
      CempCkbError,
    );
    expect(() =>
      parseCellsPage({
        objects: [
          { out_point: { tx_hash: "0x1234", index: "0x0" }, output: {}, block_number: "0x1" },
        ],
        last_cursor: "0x0",
      }),
    ).toThrow(/32-byte hash/);
    // Out-point index above uint32.
    expect(() =>
      parseCellsPage({
        objects: [
          {
            out_point: { tx_hash: fill(1, 32), index: "0x100000000" },
            output: {
              capacity: "0x100",
              lock: { code_hash: fill(2, 32), hash_type: "type", args: "0x" },
              type: null,
            },
            block_number: "0x1",
          },
        ],
        last_cursor: "0x0",
      }),
    ).toThrow(/uint32/);
  });

  it("parseTransactionStatus rejects absurd or malformed statuses", () => {
    expect(() =>
      parseTransactionStatus({ tx_status: { status: "exploded" } }, fill(1, 32)),
    ).toThrow(CempCkbError);
    expect(() =>
      parseTransactionStatus(
        { tx_status: { status: "committed", block_hash: "0x1234" } },
        fill(1, 32),
      ),
    ).toThrow(/32-byte hash/);
    expect(() => parseTransactionStatus("a string", fill(1, 32))).toThrow(CempCkbError);
  });

  it("parseLiveCellStatus rejects a live cell with malformed data", () => {
    const outPoint: OutPoint = { txHash: fill(1, 32), index: "0x0" };
    expect(() =>
      parseLiveCellStatus(
        { cell: { output: {}, data: { content: "0xzz" } }, status: "live" },
        outPoint,
      ),
    ).toThrow(CempCkbError);
    expect(() => parseLiveCellStatus({ status: "uncertain" }, outPoint)).toThrow(CempCkbError);
  });

  it("parseTransactionBody rejects giant quantities and shape tricks", () => {
    const base = {
      version: "0x0",
      cell_deps: [],
      header_deps: [],
      inputs: [],
      outputs: [
        {
          capacity: "0xffffffffffffffffff", // above u64
          lock: { code_hash: fill(1, 32), hash_type: "type", args: "0x" },
          type: null,
        },
      ],
      outputs_data: ["0x"],
      witnesses: [],
    };
    expect(() => parseTransactionBody(base, "test")).toThrow(/uint64/);
  });
});

describe("parseMessageTypeArgs robustness (task 4)", () => {
  it("rejects every malformed variant without leaking state", () => {
    for (const length of [0, 1, 32, 80, 82, 1000]) {
      expect(() => parseMessageTypeArgs(new Uint8Array(length))).toThrow(/81/);
    }
    const good = new Uint8Array(81);
    good[0] = 1;
    const parsed = parseMessageTypeArgs(good);
    expect(parsed.routeTag).toHaveLength(32);
    for (const position of [65, 70, 80]) {
      const dirty = good.slice();
      dirty[position] = 0xff;
      expect(() => parseMessageTypeArgs(dirty)).toThrow(/reserved/);
    }
  });
});

describe("RateLimiter (task 9)", () => {
  function makeStore() {
    const map = new Map<string, { tokens: number; updatedAtMs: number }>();
    return {
      map,
      get: (bucket: string) => Promise.resolve(map.get(bucket)),
      set: (bucket: string, tokens: number, updatedAtMs: number) => {
        map.set(bucket, { tokens, updatedAtMs });
        return Promise.resolve();
      },
    };
  }

  it("enforces the per-contact limit with continuous refill", async () => {
    const store = makeStore();
    let now = 1_000_000;
    const limiter = new RateLimiter(store, {
      perContactPerHour: 3,
      globalPerHour: 100,
      now: () => now,
    });
    const contact = "ab".repeat(32);
    expect(await limiter.consume("incoming", contact)).toBe(true);
    expect(await limiter.consume("incoming", contact)).toBe(true);
    expect(await limiter.consume("incoming", contact)).toBe(true);
    // 4th within the hour: denied.
    expect(await limiter.consume("incoming", contact)).toBe(false);
    // Half an hour later: 1.5 tokens refilled → 1 more allowed.
    now += 1_800_000;
    expect(await limiter.consume("incoming", contact)).toBe(true);
    expect(await limiter.consume("incoming", contact)).toBe(false);
    // Bucket state persisted (reboot keeps the limit).
    expect(store.map.get(`incoming:${contact}`)).toBeDefined();
  });

  it("global exhaustion blocks every contact; unknown senders are global-only", async () => {
    const store = makeStore();
    const limiter = new RateLimiter(store, {
      perContactPerHour: 100,
      globalPerHour: 2,
      now: () => 1_000_000,
    });
    expect(await limiter.consume("incoming", "aa".repeat(32))).toBe(true);
    expect(await limiter.consume("incoming", "bb".repeat(32))).toBe(true);
    // Global is now empty: a THIRD contact is denied despite a full bucket.
    expect(await limiter.consume("incoming", "cc".repeat(32))).toBe(false);
    expect(await limiter.consume("incoming", null)).toBe(false);
  });

  it("available() reports the refilled level for UI hints", async () => {
    const store = makeStore();
    let now = 0;
    const limiter = new RateLimiter(store, {
      perContactPerHour: 10,
      globalPerHour: 100,
      now: () => now,
    });
    const contact = "dd".repeat(32);
    await limiter.consume("outgoing", contact);
    expect(await limiter.available("outgoing", contact)).toBe(9);
    now += 36_000; // 1% of an hour → 0.1 token
    expect(await limiter.available("outgoing", contact)).toBe(9);
  });
});
