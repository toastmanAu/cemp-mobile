import { hexFrom } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { CempCkbError, parseCellsPage, parseLiveCellStatus, parseTipHeader } from "./client.js";
import { buildRouteTagPrefix, findMessageCells, watchOutpointUntilSpent } from "./discovery.js";
import type { CkbIndexerProvider, CellQuery, CellPage } from "./providers.js";
import type { Cell, OutPoint } from "./types.js";

function fill(byte: number, length: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(length)}`;
}

const routeTag = new Uint8Array(32).fill(0x72);
const cempMessageType = { codeHash: fill(0x22, 32), hashType: "type" as const };

function messageCell(argsHex: string, dataHex: string): Cell {
  return {
    outPoint: { txHash: fill(0xaa, 32), index: "0x0" },
    output: {
      capacity: "0x2540be400",
      lock: { codeHash: fill(0x33, 32), hashType: "type", args: "0x01" },
      type: { codeHash: cempMessageType.codeHash, hashType: "type", args: argsHex },
    },
    data: dataHex,
    blockNumber: "0x10",
  };
}

describe("buildRouteTagPrefix", () => {
  it("is version byte 0x01 followed by the 32-byte route tag", () => {
    const prefix = buildRouteTagPrefix(routeTag);
    expect(prefix.length).toBe(33);
    expect(prefix[0]).toBe(0x01);
    expect(Array.from(prefix.subarray(1))).toEqual(Array.from(routeTag));
  });

  it("rejects a wrong-length route tag", () => {
    expect(() => buildRouteTagPrefix(new Uint8Array(31))).toThrow(CempCkbError);
    expect(() => buildRouteTagPrefix(new Uint8Array(33))).toThrow(/expected 32/);
  });
});

describe("findMessageCells", () => {
  function mockProvider(cells: Cell[], captured: { query?: CellQuery }): CkbIndexerProvider {
    return {
      findCells(query: CellQuery): Promise<CellPage> {
        captured.query = query;
        return Promise.resolve({ cells, lastCursor: "0x99" });
      },
      findTransactions(): Promise<never> {
        return Promise.reject(new Error("not used"));
      },
    };
  }

  it("issues a type-script prefix query over version ‖ route_tag", async () => {
    const captured: { query?: CellQuery } = {};
    const prefix = buildRouteTagPrefix(routeTag);
    // 81-byte args: 33-byte prefix ‖ conversation_tag ‖ message_nonce ‖ reserved.
    const validArgs = `${hexFrom(prefix)}${"63".repeat(16)}${"6e".repeat(16)}${"00".repeat(16)}`;
    const cells = [messageCell(validArgs, "0x1234")];
    const page = await findMessageCells(mockProvider(cells, captured), cempMessageType, routeTag);

    expect(captured.query!.scriptType).toBe("type");
    expect(captured.query!.argsSearchMode).toBe("prefix");
    expect(captured.query!.script.codeHash).toBe(cempMessageType.codeHash);
    expect(captured.query!.script.args).toBe(hexFrom(prefix));
    expect(page.cells.length).toBe(1);
    expect(page.lastCursor).toBe("0x99");
  });

  it("passes the pagination cursor through", async () => {
    const captured: { query?: CellQuery } = {};
    await findMessageCells(mockProvider([], captured), cempMessageType, routeTag, "0x42");
    expect(captured.query!.after).toBe("0x42");
  });

  it("drops non-matching and oversized cells (hostile indexer output)", async () => {
    const prefix = buildRouteTagPrefix(routeTag);
    const good = `${hexFrom(prefix)}${"63".repeat(16)}${"6e".repeat(16)}${"00".repeat(16)}`;
    const wrongPrefix = `0x01${"74".repeat(32)}${"63".repeat(16)}${"6e".repeat(16)}${"00".repeat(16)}`;
    const short = `${hexFrom(prefix)}${"63".repeat(16)}${"6e".repeat(16)}${"00".repeat(15)}`; // 80 bytes
    const cells = [
      messageCell(good, "0x1234"),
      messageCell(wrongPrefix, "0x1234"),
      messageCell(short, "0x1234"),
      messageCell(good, `0x${"00".repeat(82_001)}`), // over the §11 envelope limit
      {
        ...messageCell(good, "0x1234"),
        output: { ...messageCell(good, "0x1234").output, type: null },
      },
    ];
    const page = await findMessageCells(mockProvider(cells, {}), cempMessageType, routeTag);
    expect(page.cells.length).toBe(1);
    expect(page.cells[0]!.output.type!.args).toBe(good);
  });
});

describe("indexer/RPC response shape validation (rule 4)", () => {
  const validCellJson = {
    out_point: { tx_hash: fill(0xaa, 32), index: "0x0" },
    output: {
      capacity: "0x2540be400",
      lock: { code_hash: fill(0x33, 32), hash_type: "type", args: "0x01" },
      type: null,
    },
    output_data: "0x1234",
    block_number: "0x10",
  };

  it("parses a well-formed get_cells page", () => {
    const page = parseCellsPage({ last_cursor: "0x99", objects: [validCellJson] });
    expect(page.lastCursor).toBe("0x99");
    expect(page.cells.length).toBe(1);
    expect(page.cells[0]!.data).toBe("0x1234");
    expect(page.cells[0]!.blockNumber).toBe("0x10");
  });

  it("rejects garbage at every level with clean errors", () => {
    expect(() => parseCellsPage("not json")).toThrow(CempCkbError);
    expect(() => parseCellsPage({})).toThrow(/last_cursor/);
    expect(() => parseCellsPage({ last_cursor: "0x99", objects: {} })).toThrow(/array/);
    expect(() => parseCellsPage({ last_cursor: "0x99", objects: [{}] })).toThrow(/out_point/);
    expect(() =>
      parseCellsPage({
        last_cursor: "0x99",
        objects: [{ ...validCellJson, out_point: { tx_hash: "0x12", index: "0x0" } }],
      }),
    ).toThrow(/32-byte hash/);
    expect(() =>
      parseCellsPage({
        last_cursor: "0x99",
        objects: [
          {
            ...validCellJson,
            out_point: { tx_hash: fill(0xaa, 32), index: "0x1_0000_0000".replaceAll("_", "") },
          },
        ],
      }),
    ).toThrow(/uint32/);
    expect(() =>
      parseCellsPage({
        last_cursor: "0x99",
        objects: [
          {
            ...validCellJson,
            output: {
              ...validCellJson.output,
              capacity: "0x1_0000_0000_0000_0000_00".replaceAll("_", ""),
            },
          },
        ],
      }),
    ).toThrow(/uint64/);
    expect(() =>
      parseCellsPage({
        last_cursor: "0x99",
        objects: [
          {
            ...validCellJson,
            output: {
              ...validCellJson.output,
              lock: { code_hash: fill(0x33, 32), hash_type: "data3", args: "0x" },
            },
          },
        ],
      }),
    ).toThrow(/hash_type/);
    expect(() =>
      parseCellsPage({
        last_cursor: "0x99",
        objects: [{ ...validCellJson, output_data: "0xz1" }],
      }),
    ).toThrow(/hex/);
  });

  it("maps output_data null to empty bytes", () => {
    const page = parseCellsPage({
      last_cursor: "0x99",
      objects: [{ ...validCellJson, output_data: null }],
    });
    expect(page.cells[0]!.data).toBe("0x");
  });

  it("validates get_live_cell statuses", () => {
    const outPoint: OutPoint = { txHash: fill(0xaa, 32), index: "0x0" };
    const live = parseLiveCellStatus(
      {
        status: "live",
        cell: {
          output: validCellJson.output,
          data: { content: "0xabcd", hash: fill(0x44, 32) },
        },
      },
      outPoint,
    );
    expect(live.status).toBe("live");
    if (live.status === "live") {
      expect(live.cell.data).toBe("0xabcd");
      expect(live.cell.outPoint).toBe(outPoint);
    }
    expect(parseLiveCellStatus({ status: "dead", cell: null }, outPoint).status).toBe("dead");
    expect(parseLiveCellStatus({ status: "unknown", cell: null }, outPoint).status).toBe("unknown");
    expect(() => parseLiveCellStatus({ status: "weird", cell: null }, outPoint)).toThrow(
      /unknown status/,
    );
    expect(() => parseLiveCellStatus({ status: "live", cell: null }, outPoint)).toThrow(
      CempCkbError,
    );
  });

  it("validates the tip header shape", () => {
    const header = parseTipHeader({
      number: "0x10",
      epoch: "0x20",
      timestamp: "0x30",
      hash: fill(0xbb, 32),
    });
    expect(header.number).toBe("0x10");
    expect(() => parseTipHeader({ number: "0x10" })).toThrow(CempCkbError);
    expect(() =>
      parseTipHeader({ number: "0x10", epoch: "0x20", timestamp: "0x30", hash: "0x12" }),
    ).toThrow(/32-byte hash/);
  });
});

describe("watchOutpointUntilSpent", () => {
  const outPoint: OutPoint = { txHash: fill(0xaa, 32), index: "0x0" };

  it("returns spent once the cell is no longer live", async () => {
    const statuses = ["live", "live", "dead"] as const;
    let calls = 0;
    const result = await watchOutpointUntilSpent(
      {
        getLiveCell: () => {
          const status = statuses[Math.min(calls, statuses.length - 1)]!;
          calls += 1;
          return Promise.resolve({ status, outPoint } as never);
        },
      },
      outPoint,
      { pollIntervalMs: 1, timeoutMs: 1_000 },
    );
    expect(result).toBe("spent");
    expect(calls).toBe(3);
  });

  it("returns timeout when the cell stays live", async () => {
    const result = await watchOutpointUntilSpent(
      { getLiveCell: () => Promise.resolve({ status: "live", cell: {} } as never) },
      outPoint,
      { pollIntervalMs: 1, timeoutMs: 25 },
    );
    expect(result).toBe("timeout");
  });
});
