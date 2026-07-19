import { describe, expect, it } from "vitest";
import type { JsonRpcTransport } from "@cemp/ckb";
import { outpointsForTag } from "./locked-probe";

const TAG = "cd".repeat(32);
// 81-byte message-cell type args: version(1) ‖ route_tag(32) ‖ conversation_tag(16)
// ‖ message_nonce(16) ‖ reserved(16) — see MESSAGE_TYPE_ARGS in @cemp/ckb.
const MESSAGE_TYPE_ARGS_HEX = `0x01${TAG}${"00".repeat(48)}`;

describe("locked probe", () => {
  it("returns txHash:index for every cell at the tag", async () => {
    const transport: JsonRpcTransport = {
      call: (_url, method) =>
        method === "get_cells"
          ? Promise.resolve({
              objects: [
                {
                  out_point: { tx_hash: `0x${"ab".repeat(32)}`, index: "0x0" },
                  block_number: "0x0",
                  output: {
                    capacity: "0x0",
                    lock: { code_hash: `0x${"00".repeat(32)}`, hash_type: "type", args: "0x" },
                    type: {
                      code_hash: `0x${"11".repeat(32)}`,
                      hash_type: "type",
                      args: MESSAGE_TYPE_ARGS_HEX,
                    },
                  },
                  output_data: "0x",
                },
              ],
              last_cursor: "0x",
            })
          : Promise.reject(new Error(`unexpected ${method}`)),
    };
    const found = await outpointsForTag(TAG, transport);
    expect(found).toEqual([`0x${"ab".repeat(32)}:0`]);
  });

  it("returns nothing when the tag has no cells", async () => {
    const transport: JsonRpcTransport = {
      call: () => Promise.resolve({ objects: [], last_cursor: "0x" }),
    };
    expect(await outpointsForTag(TAG, transport)).toEqual([]);
  });
});
