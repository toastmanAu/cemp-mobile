import { describe, expect, it } from "vitest";
import type { JsonRpcTransport } from "@cemp/ckb";
import { outpointsForTag } from "./locked-probe";

const TAG = "cd".repeat(32);
// A message cell's capacity is the CKB it locks; 200 CKB (in shannons) is a
// realistic size for one. "0x0" would not be a physically valid cell.
const CAPACITY = "0x4a817c800";

/** 81-byte message-cell type args: version(1) ‖ route_tag(32) ‖ conversation_tag(16)
 *  ‖ message_nonce(16) ‖ reserved(16) — see MESSAGE_TYPE_ARGS in @cemp/ckb. The
 *  nonce region varies per cell, which is why the indexer's `asc` ordering over
 *  these args puts new arrivals at arbitrary positions within a tag. */
function typeArgs(nonceByte: string): string {
  return `0x01${TAG}${"00".repeat(16)}${nonceByte.repeat(16)}${"00".repeat(16)}`;
}

function cell(txHashByte: string, index: string, nonceByte = "00"): Record<string, unknown> {
  return {
    out_point: { tx_hash: `0x${txHashByte.repeat(32)}`, index },
    block_number: "0x1",
    output: {
      capacity: CAPACITY,
      lock: { code_hash: `0x${"00".repeat(32)}`, hash_type: "type", args: "0x" },
      type: {
        code_hash: `0x${"11".repeat(32)}`,
        hash_type: "type",
        args: typeArgs(nonceByte),
      },
    },
    output_data: "0x",
  };
}

/** Records every `after` cursor the probe sends, so pagination is observable. */
function pagingTransport(pages: { objects: unknown[]; last_cursor: string }[]): {
  transport: JsonRpcTransport;
  cursors: (string | undefined)[];
} {
  const cursors: (string | undefined)[] = [];
  let call = 0;
  const transport: JsonRpcTransport = {
    call: (_url, method, params) => {
      if (method !== "get_cells") {
        return Promise.reject(new Error(`unexpected ${method}`));
      }
      cursors.push((params as unknown[])[3] as string | undefined);
      const page = pages[call];
      call += 1;
      if (page === undefined) {
        // A page the probe should never have asked for. Returning cells here
        // would make an over-fetch silently pass, so fail loudly instead.
        return Promise.reject(new Error("probe requested a page past exhaustion"));
      }
      return Promise.resolve(page);
    },
  };
  return { transport, cursors };
}

describe("locked probe", () => {
  it("returns txHash:index for every cell at the tag", async () => {
    const { transport } = pagingTransport([{ objects: [cell("ab", "0x0")], last_cursor: "0x" }]);
    expect(await outpointsForTag(TAG, transport)).toEqual([`0x${"ab".repeat(32)}:0`]);
  });

  it("returns nothing when the tag has no cells", async () => {
    const { transport } = pagingTransport([{ objects: [], last_cursor: "0x" }]);
    expect(await outpointsForTag(TAG, transport)).toEqual([]);
  });

  /* ── I1: FULL scan, not just the first page ─────────────────────────────── */

  it("follows the cursor across pages and returns cells from every one", async () => {
    const { transport, cursors } = pagingTransport([
      { objects: [cell("a1", "0x0", "11"), cell("a2", "0x1", "22")], last_cursor: "0xc1" },
      { objects: [cell("b1", "0x0", "33")], last_cursor: "0xc2" },
      { objects: [cell("c1", "0x2", "44")], last_cursor: "0x" },
    ]);

    const found = await outpointsForTag(TAG, transport);

    // Cells from pages 2 and 3 are present — a first-page-only read would
    // return just the first two and go permanently dark for later arrivals.
    expect(found).toEqual([
      `0x${"a1".repeat(32)}:0`,
      `0x${"a2".repeat(32)}:1`,
      `0x${"b1".repeat(32)}:0`,
      `0x${"c1".repeat(32)}:2`,
    ]);
    // First request is cursorless; each later one carries the previous page's
    // cursor.
    expect(cursors).toEqual([undefined, "0xc1", "0xc2"]);
  });

  it("stops on the terminal 0x cursor and never pages on it", async () => {
    // The indexer returns last_cursor "0x" on an exhausted scan, and
    // get_cells(after: "0x") then returns NOTHING FOREVER — even once new
    // cells arrive. Paging on it is the bug that once lost every inbound
    // message, so the probe must stop here.
    const { transport, cursors } = pagingTransport([
      { objects: [cell("a1", "0x0", "11")], last_cursor: "0xc1" },
      { objects: [cell("b1", "0x0", "22")], last_cursor: "0x" },
    ]);

    const found = await outpointsForTag(TAG, transport);

    expect(found).toEqual([`0x${"a1".repeat(32)}:0`, `0x${"b1".repeat(32)}:0`]);
    expect(cursors).toEqual([undefined, "0xc1"]);
    expect(cursors).not.toContain("0x");
  });

  it("stops on an empty page even when the cursor is non-terminal", async () => {
    const { transport, cursors } = pagingTransport([
      { objects: [cell("a1", "0x0", "11")], last_cursor: "0xc1" },
      { objects: [], last_cursor: "0xc2" },
    ]);

    expect(await outpointsForTag(TAG, transport)).toEqual([`0x${"a1".repeat(32)}:0`]);
    expect(cursors).toEqual([undefined, "0xc1"]);
  });

  it("stops on an empty-string cursor", async () => {
    const { transport, cursors } = pagingTransport([
      { objects: [cell("a1", "0x0", "11")], last_cursor: "" },
    ]);

    expect(await outpointsForTag(TAG, transport)).toEqual([`0x${"a1".repeat(32)}:0`]);
    expect(cursors).toEqual([undefined]);
  });

  it("exhausts a tag holding more cells than one page", async () => {
    // 64 cells is DEFAULT_FIND_LIMIT: the exact size at which a first-page-only
    // read starts losing every new arrival.
    const first = Array.from({ length: 64 }, (_, i) =>
      cell("aa", `0x${i.toString(16)}`, i.toString(16).padStart(2, "0")),
    );
    const { transport } = pagingTransport([
      { objects: first, last_cursor: "0xc1" },
      { objects: [cell("ff", "0x0", "ee")], last_cursor: "0x" },
    ]);

    const found = await outpointsForTag(TAG, transport);

    expect(found).toHaveLength(65);
    expect(found.at(-1)).toBe(`0x${"ff".repeat(32)}:0`);
  });
});
