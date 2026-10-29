/**
 * CRC-32 (IEEE 802.3, polynomial 0xEDB88320, init 0xFFFFFFFF, final XOR
 * 0xFFFFFFFF — the standard zlib crc32). The LoRa gateway tags each
 * reassembled object with this checksum; the transport verifies it before
 * the bytes go anywhere near the incoming pipeline (rule 4).
 *
 * Zero-dependency, table-driven; runs in Node, Hermes, and future iOS
 * contexts (rule 14). Known check vector: ASCII "123456789" → 0xCBF43926.
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard zlib CRC-32 of `bytes`, returned as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
