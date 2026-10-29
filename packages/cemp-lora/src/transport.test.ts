import { codec } from "@cemp/core";
import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32.js";
import {
  LoraTransport,
  LoraTransportError,
  type LoraObject,
  type LoraTransportConfig,
} from "./transport.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const TAG_A = hexToBytes("aa".repeat(32));
const TAG_B = hexToBytes("bb".repeat(32));

/**
 * Realistic valid-envelope fixtures: deterministic codec envelopes from
 * cemp-core's golden-vector fixtures (spec §14), so every "good" object
 * passes the same codec.validateEnvelope the transport runs. `buildEnvelope`
 * uses fill bytes for message id; override it per fixture for distinct ids.
 */
function validEnvelopeBytes(messageIdFill: number): Uint8Array {
  const envelope = codec.buildEnvelope(false);
  envelope.header.message_id = new Uint8Array(16).fill(messageIdFill);
  return codec.encodeCempEnvelopeV1(envelope);
}

function goodEntry(messageIdFill: number, receivedAt = 1_735_689_600) {
  const cellData = validEnvelopeBytes(messageIdFill);
  // The gateway id IS the envelope's 16-byte message id as hex.
  return {
    id: bytesToHex(new Uint8Array(16).fill(messageIdFill)),
    bytes_hex: bytesToHex(cellData),
    crc32: crc32(cellData),
    received_at: receivedAt,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type FetchMock = (url: string) => Promise<Response>;

function makeTransport(
  fetchFn: FetchMock,
  overrides: Partial<LoraTransportConfig> = {},
): { transport: LoraTransport; urls: string[] } {
  const urls: string[] = [];
  const recordingFetch = (async (url: string | URL) => {
    urls.push(String(url));
    return fetchFn(String(url));
  }) as unknown as typeof fetch;
  const transport = new LoraTransport({
    baseUrl: "http://192.168.1.10:8080/",
    routeTags: [TAG_A, TAG_B],
    fetchFn: recordingFetch,
    ...overrides,
  });
  return { transport, urls };
}

function routeOf(url: string): string {
  return new URL(url).searchParams.get("route") ?? "";
}

describe("LoraTransport config", () => {
  it("rejects an empty baseUrl", () => {
    expect(
      () =>
        new LoraTransport({
          baseUrl: "///",
          routeTags: [TAG_A],
          fetchFn: (async () => jsonResponse({})) as typeof fetch,
        }),
    ).toThrow(LoraTransportError);
  });

  it("rejects route tags that are not 32 bytes", () => {
    expect(
      () =>
        new LoraTransport({
          baseUrl: "http://gw",
          routeTags: [new Uint8Array(16)],
          fetchFn: (async () => jsonResponse({})) as typeof fetch,
        }),
    ).toThrow(/32 bytes/);
  });
});

describe("LoraTransport.poll", () => {
  it("merges route tags, dedups by id, and passes the cursor through", async () => {
    const entry1 = goodEntry(0x11);
    const entry2 = goodEntry(0x22);
    // entry1 surfaces under BOTH route tags (gateway reassembly overlap).
    const fetchFn: FetchMock = async (url) => {
      const route = routeOf(url);
      if (route === bytesToHex(TAG_A)) {
        return jsonResponse({ objects: [entry1, entry2], cursor: "00000042" });
      }
      return jsonResponse({ objects: [entry1], cursor: "00000043" });
    };
    const { transport, urls } = makeTransport(fetchFn);
    const result = await transport.poll("00000040");
    expect(urls).toHaveLength(2);
    expect(routeOf(urls[0]!)).toBe(bytesToHex(TAG_A));
    expect(routeOf(urls[1]!)).toBe(bytesToHex(TAG_B));
    expect(new URL(urls[0]!).searchParams.get("since")).toBe("00000040");
    expect(result.objects.map((o: LoraObject) => o.id).sort()).toEqual(
      [entry1.id, entry2.id].sort(),
    );
    // Merged cursor = the latest of the per-route cursors.
    expect(result.cursor).toBe("00000043");
    // Round-trip integrity: bytes came back exactly as the gateway sent them.
    expect(bytesToHex(result.objects.find((o) => o.id === entry2.id)!.cellData)).toBe(
      entry2.bytes_hex,
    );
  });

  it("omits the since param on the first poll and returns null cursor when none came back", async () => {
    const fetchFn: FetchMock = async () => jsonResponse({ objects: [], cursor: "" });
    const { transport, urls } = makeTransport(fetchFn, { routeTags: [TAG_A] });
    const result = await transport.poll(null);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.has("since")).toBe(false);
    expect(result.objects).toEqual([]);
    expect(result.cursor).toBeNull();
  });

  it("caps the merged result at maxObjectsPerPoll", async () => {
    const entries = [goodEntry(0x01), goodEntry(0x02), goodEntry(0x03)];
    const fetchFn: FetchMock = async () => jsonResponse({ objects: entries, cursor: "9" });
    const { transport } = makeTransport(fetchFn, { routeTags: [TAG_A], maxObjectsPerPoll: 2 });
    const result = await transport.poll(null);
    expect(result.objects).toHaveLength(2);
    expect(result.cursor).toBe("9");
  });

  it("drops hostile entries (bad hex, crc mismatch, wrong-length id, oversized, non-envelope) but keeps good ones", async () => {
    const good = goodEntry(0x77);
    const goodBytes = hexToBytes(good.bytes_hex);
    const hostile = [
      // Odd-length hex.
      { id: "cd".repeat(16), bytes_hex: "abc", crc32: 0, received_at: 1 },
      // Non-hex characters.
      { id: "cd".repeat(16), bytes_hex: "zz", crc32: 0, received_at: 1 },
      // Wrong-length id (not 16 bytes / 32 hex chars).
      { ...good, id: "abcd" },
      // CRC mismatch.
      { ...good, id: "ce".repeat(16), crc32: (good.crc32 ^ 1) >>> 0 },
      // Valid hex+crc but not a CEMP envelope (fails codec.validateEnvelope).
      (() => {
        const junk = hexToBytes("00".repeat(64));
        return {
          id: "cf".repeat(16),
          bytes_hex: bytesToHex(junk),
          crc32: crc32(junk),
          received_at: 1,
        };
      })(),
      // Oversized payload (just over the spec §11 envelope limit).
      (() => {
        const big = new Uint8Array(codec.V1_LIMITS.maxEnvelopeBytes + 1);
        return {
          id: "d0".repeat(16),
          bytes_hex: bytesToHex(big),
          crc32: crc32(big),
          received_at: 1,
        };
      })(),
      // Not an object at all.
      "garbage",
      null,
      // Good envelope bytes with a tampered received_at type.
      { ...good, id: "d1".repeat(16), received_at: "not-a-number" },
    ];
    const fetchFn: FetchMock = async () =>
      jsonResponse({ objects: [...hostile, good], cursor: "7" });
    const { transport } = makeTransport(fetchFn, { routeTags: [TAG_A] });
    const result = await transport.poll(null);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.id).toBe(good.id);
    expect(result.objects[0]!.cellData).toEqual(goodBytes);
    expect(result.cursor).toBe("7");
  });

  it("throws LoraTransportError on non-200 responses", async () => {
    const fetchFn: FetchMock = async () => jsonResponse({}, 500);
    const { transport } = makeTransport(fetchFn, { routeTags: [TAG_A] });
    const error = await transport.poll(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoraTransportError);
    expect((error as LoraTransportError).status).toBe(500);
  });

  it("throws LoraTransportError on network failure", async () => {
    const fetchFn: FetchMock = () => Promise.reject(new Error("ECONNREFUSED"));
    const { transport } = makeTransport(fetchFn, { routeTags: [TAG_A] });
    const error = await transport.poll(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoraTransportError);
    expect((error as LoraTransportError).status).toBeNull();
  });

  it("throws LoraTransportError on a malformed top-level response", async () => {
    const fetchFn: FetchMock = async () => jsonResponse({ nope: true });
    const { transport } = makeTransport(fetchFn, { routeTags: [TAG_A] });
    await expect(transport.poll(null)).rejects.toThrow(LoraTransportError);
  });
});

describe("LoraTransport.health", () => {
  it("is true on a 200 response", async () => {
    const { transport, urls } = makeTransport(async () => jsonResponse({}), {
      routeTags: [TAG_A],
    });
    await expect(transport.health()).resolves.toBe(true);
    expect(urls[0]!).toBe("http://192.168.1.10:8080/cemp/health");
  });

  it("is false on non-200 and on network error, never throwing", async () => {
    const { transport: down } = makeTransport(async () => jsonResponse({}, 503), {
      routeTags: [TAG_A],
    });
    await expect(down.health()).resolves.toBe(false);
    const { transport: unreachable } = makeTransport(
      () => Promise.reject(new Error("unreachable")),
      { routeTags: [TAG_A] },
    );
    await expect(unreachable.health()).resolves.toBe(false);
  });
});
