/**
 * LoRa gateway polling transport (docs/lora-transport/IMPLEMENTATION.md,
 * Phase L2). Polls the `sensecap-gw` gateway's local HTTP endpoint for
 * reassembled CEMP envelope objects and returns validated raw envelope bytes
 * ("cellData") that `processIncomingText` (packages/cemp-ckb/src/incoming.ts)
 * consumes unchanged.
 *
 * Gateway contract (coded against the gateway repo, Phase L1):
 *   GET {baseUrl}/cemp/objects?route=<routeTagHex>&since=<cursor>
 *     → 200 { objects: [{ id, bytes_hex, crc32, received_at }], cursor }
 *   GET {baseUrl}/cemp/health → 200
 *
 * The app subscribes by ROUTE TAG, never by profile id — a leaked route tag
 * exposes one epoch's inbox; a leaked profile id exposes every epoch's.
 *
 * Everything the gateway returns is hostile input (AGENTS.md rule 4): a
 * malformed entry is dropped, never fails the whole poll; a malformed
 * response envelope (non-200, non-JSON, wrong top-level shape) throws a
 * typed `LoraTransportError` so the sync engine's worker backoff applies.
 * Platform-neutral (rule 14): no Node APIs, no RN imports.
 */

import { codec } from "@cemp/core";
import { crc32 } from "./crc32.js";

export interface LoraTransportConfig {
  /** Gateway base URL, e.g. "http://192.168.1.10:8080" (trailing slashes ok). */
  baseUrl: string;
  /** Prev/current/next epoch route tags; each is polled as its own ?route= query. */
  routeTags: Uint8Array[];
  /** Injectable for tests / RN; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Cap on merged, deduplicated objects returned per poll. Default 64. */
  maxObjectsPerPoll?: number;
  /** Per-request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

export interface LoraObject {
  /** The envelope's 16-byte message id, lowercase hex (32 chars). */
  id: string;
  /** Raw CEMP envelope bytes, validated (shape + crc + codec.validateEnvelope). */
  cellData: Uint8Array;
  /** The gateway-supplied crc32 after verification (kept for audit/logging). */
  crc32: number;
  /** Gateway-side receive timestamp (unix seconds). */
  receivedAt: number;
}

export interface LoraPollResult {
  objects: LoraObject[];
  /**
   * Cursor to pass to the next poll, or null when the gateway returned no
   * cursor. With multiple route tags the gateway returns one cursor per
   * query; the merged cursor is the lexicographically largest non-empty one
   * (gateway cursors are zero-padded monotonic sequence numbers).
   */
  cursor: string | null;
}

/** Transport-level failure: network error, non-200, or malformed response body. */
export class LoraTransportError extends Error {
  /** HTTP status when the failure came from a response, else null. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoraTransportError";
    this.status = status;
  }
}

const DEFAULT_MAX_OBJECTS_PER_POLL = 64;
const DEFAULT_TIMEOUT_MS = 10_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Strict hex decode for hostile input (rule 4); returns null on any violation. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export class LoraTransport {
  private readonly baseUrl: string;
  private readonly routeTags: Uint8Array[];
  private readonly fetchFn: typeof fetch;
  private readonly maxObjectsPerPoll: number;
  private readonly timeoutMs: number;

  constructor(config: LoraTransportConfig) {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    if (baseUrl.length === 0) {
      throw new LoraTransportError("lora: baseUrl must not be empty");
    }
    const fetchFn = config.fetchFn ?? (typeof fetch === "function" ? fetch : undefined);
    if (fetchFn === undefined) {
      throw new LoraTransportError("lora: no fetch implementation available; pass config.fetchFn");
    }
    for (const tag of config.routeTags) {
      if (tag.byteLength !== 32) {
        throw new LoraTransportError(
          `lora: route tags must be 32 bytes, got ${String(tag.byteLength)}`,
        );
      }
    }
    this.baseUrl = baseUrl;
    this.routeTags = config.routeTags;
    this.fetchFn = fetchFn;
    this.maxObjectsPerPoll = config.maxObjectsPerPoll ?? DEFAULT_MAX_OBJECTS_PER_POLL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Poll every configured route tag once, merge the results, dedup by
   * envelope message id, and return up to `maxObjectsPerPoll` objects plus
   * the merged cursor. Malformed individual entries are dropped silently
   * (ids/lengths only ever reach logs); response-level failures throw
   * `LoraTransportError`.
   */
  async poll(sinceCursor: string | null): Promise<LoraPollResult> {
    const byId = new Map<string, LoraObject>();
    let cursor: string | null = null;
    for (const tag of this.routeTags) {
      let path = `/cemp/objects?route=${bytesToHex(tag)}`;
      if (sinceCursor !== null) {
        path += `&since=${encodeURIComponent(sinceCursor)}`;
      }
      const body = await this.fetchJson(path);
      const page = parseObjectsResponse(body);
      for (const entry of page.objects) {
        const object = sanitizeObject(entry);
        if (object === null) {
          continue; // hostile/garbled entry: drop, never stall the poll (rule 4)
        }
        if (byId.has(object.id)) {
          continue; // same envelope surfaced under another route tag
        }
        if (byId.size >= this.maxObjectsPerPoll) {
          continue; // cap reached; the cursor still merges below
        }
        byId.set(object.id, object);
      }
      if (page.cursor.length > 0 && (cursor === null || page.cursor > cursor)) {
        cursor = page.cursor;
      }
    }
    return { objects: [...byId.values()], cursor };
  }

  /** Gateway reachability probe; never throws. */
  async health(): Promise<boolean> {
    try {
      const response = await this.fetchRaw("/cemp/health");
      return response.ok;
    } catch {
      return false;
    }
  }

  private async fetchJson(path: string): Promise<unknown> {
    const response = await this.fetchRaw(path);
    if (!response.ok) {
      throw new LoraTransportError(
        `lora: gateway returned HTTP ${String(response.status)} for ${path}`,
        response.status,
      );
    }
    try {
      return await response.json();
    } catch (e) {
      throw new LoraTransportError("lora: gateway returned a non-JSON body", response.status, {
        cause: e,
      });
    }
  }

  /** fetch with the configured timeout (AbortController where the runtime has one). */
  private async fetchRaw(path: string): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    // Hermes gained AbortController late; without it the request simply runs
    // untimed rather than crashing the poll.
    if (typeof AbortController !== "undefined") {
      const controller = new AbortController();
      timer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);
      signal = controller.signal;
    }
    try {
      return await this.fetchFn(
        `${this.baseUrl}${path}`,
        signal === undefined ? undefined : { signal },
      );
    } catch (e) {
      throw new LoraTransportError(
        `lora: request to ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
        null,
        { cause: e },
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

/** Top-level response shape; a violation here is a gateway bug → typed error. */
function parseObjectsResponse(body: unknown): { objects: unknown[]; cursor: string } {
  if (typeof body !== "object" || body === null) {
    throw new LoraTransportError("lora: /cemp/objects returned a non-object body");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.objects)) {
    throw new LoraTransportError("lora: /cemp/objects response has no objects array");
  }
  if (typeof record.cursor !== "string") {
    throw new LoraTransportError("lora: /cemp/objects response has no string cursor");
  }
  return { objects: record.objects, cursor: record.cursor };
}

/**
 * Per-entry validation (rule 4). Returns null for anything malformed:
 * wrong-length id, bad/oversized hex, crc mismatch, or bytes that fail the
 * codec's key-free envelope validation (shape/version/limits, spec §12) —
 * the same check `decryptEnvelope` re-runs before any decapsulation.
 */
function sanitizeObject(entry: unknown): LoraObject | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !/^[0-9a-fA-F]{32}$/.test(id)) {
    return null;
  }
  const bytesHex = record.bytes_hex;
  if (typeof bytesHex !== "string") {
    return null;
  }
  const cellData = hexToBytes(bytesHex);
  if (cellData === null || cellData.byteLength > codec.V1_LIMITS.maxEnvelopeBytes) {
    return null;
  }
  const crc = record.crc32;
  if (typeof crc !== "number" || !Number.isInteger(crc) || crc < 0 || crc > 0xffffffff) {
    return null;
  }
  const receivedAt = record.received_at;
  if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) {
    return null;
  }
  if (crc32(cellData) !== crc) {
    return null;
  }
  if (!codec.validateEnvelope(cellData).ok) {
    return null;
  }
  return { id: id.toLowerCase(), cellData, crc32: crc, receivedAt };
}
