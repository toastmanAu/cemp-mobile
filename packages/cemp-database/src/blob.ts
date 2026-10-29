/**
 * BLOB normalization at the repository / adapter boundary.
 *
 * The `SqlValue` contract says a BLOB column reads back as a
 * `Uint8Array`, but SQLite drivers disagree: node:sqlite yields `Uint8Array`
 * while op-sqlite (the Android SQLCipher driver) yields a bare `ArrayBuffer`
 * (`cpp/utils.cpp` constructs a JS `ArrayBuffer` for every BLOB cell). An
 * `ArrayBuffer` has no `.fill`, `.slice` semantics differ, and `.length` is
 * undefined — so a repository that merely casts the value hands consumers
 * an object that type-checks but explodes at the first typed-array call.
 *
 * Device finding (runbook 2026-08-15 Phase 2D, root-caused 2026-10-30): the
 * stored `attachments.attachment_key` reached
 * `MessagingService.downloadImageAttachment` as an `ArrayBuffer`; its
 * `key.fill(0)` finally-wipe threw `TypeError: undefined is not a function`,
 * which — because a throw in a `finally` replaces the in-flight outcome —
 * was the only error the user ever saw. Emulator runs did not reproduce it
 * because the key there came from the chain re-derivation path, not the DB.
 *
 * @module
 */

/**
 * Convert a driver-dependent BLOB cell value to a `Uint8Array`, or null.
 *
 * Accepts `Uint8Array`, `ArrayBuffer` and any other `ArrayBufferView`. SQL
 * NULL, an empty blob, and any non-binary shape all map to `null` — the
 * documented "nothing stored" meaning — so callers take their fallback path
 * instead of failing inside a typed-array call. Strings are deliberately NOT
 * guessed at (a hex string is also valid base64; decoding either would
 * silently produce wrong key bytes).
 */
export function blobToBytes(value: unknown): Uint8Array | null {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return null;
  }
  return bytes.length === 0 ? null : bytes;
}

/**
 * Rewrite a driver's result rows so every binary cell is a `Uint8Array`,
 * honouring the `SqlValue` contract at the adapter boundary.
 *
 * Unlike {@link blobToBytes} this is lossless: an empty blob stays an empty
 * `Uint8Array` and non-binary cells pass through untouched. Rows are copied
 * only when a cell actually needs converting.
 */
export function normalizeBlobCells<R extends Record<string, unknown>>(rows: readonly R[]): R[] {
  return rows.map((row) => {
    let copy: Record<string, unknown> | null = null;
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (value instanceof Uint8Array) {
        continue;
      }
      let bytes: Uint8Array | null = null;
      if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      if (bytes !== null) {
        copy ??= { ...row };
        copy[key] = bytes;
      }
    }
    return (copy ?? row) as R;
  });
}
