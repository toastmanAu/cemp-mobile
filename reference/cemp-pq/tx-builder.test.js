import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeMessagePointer, serializeProfile } from "./index.js";

test("serializeMessagePointer produces bytes >= 36", () => {
  const txHash = "0x" + "ab".repeat(32);
  const bytes = serializeMessagePointer(txHash, 0);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length >= 36, `expected at least 36 bytes, got ${bytes.length}`);
});

test("serializeProfile roundtrip via offset-based parsing", () => {
  const dsaPub = new Uint8Array(1952).fill(0xa1);
  const kemPub = new Uint8Array(1184).fill(0xa2);
  const meta = new TextEncoder().encode(JSON.stringify({ displayName: "Test" }));
  const profileBytes = serializeProfile(dsaPub, kemPub, meta);

  const view = new DataView(profileBytes.buffer, profileBytes.byteOffset, profileBytes.byteLength);
  const offDsa = view.getUint32(4, true);
  const offKem = view.getUint32(8, true);
  const offMeta = view.getUint32(12, true);

  const dsaLen = view.getUint32(offDsa, true);
  assert.equal(dsaLen, 1952);

  const kemLen = view.getUint32(offKem, true);
  assert.equal(kemLen, 1184);

  const metaLen = view.getUint32(offMeta, true);
  assert.equal(metaLen, meta.length);

  const extractedDsa = profileBytes.subarray(offDsa + 4, offDsa + 4 + dsaLen);
  assert.equal(extractedDsa[0], 0xa1);
  assert.equal(extractedDsa[1951], 0xa1);

  const extractedKem = profileBytes.subarray(offKem + 4, offKem + 4 + kemLen);
  assert.equal(extractedKem[0], 0xa2);
  assert.equal(extractedKem[1183], 0xa2);

  const extractedMeta = profileBytes.subarray(offMeta + 4, offMeta + 4 + metaLen);
  assert.deepEqual(Array.from(extractedMeta), Array.from(meta));
});

test("serializeMessagePointer with non-zero index produces distinct output", () => {
  const txHash = "0x" + "cd".repeat(32);
  const ptr0 = serializeMessagePointer(txHash, 0);
  const ptr1 = serializeMessagePointer(txHash, 1);
  assert.notDeepEqual(Array.from(ptr0), Array.from(ptr1));
});

import { ML_DSA_TESTNET, ML_DSA_MAINNET, getMlDsaConstants } from "./index.js";

test("getMlDsaConstants returns testnet constants for testnet", () => {
  const testnetConsts = getMlDsaConstants("testnet");
  assert.deepEqual(testnetConsts, ML_DSA_TESTNET);
  assert.match(ML_DSA_TESTNET.CODE_HASH, /^0x[0-9a-f]{64}$/);
});

test("getMlDsaConstants throws on mainnet while contract is undeployed", () => {
  assert.throws(
    () => getMlDsaConstants("mainnet"),
    /not deployed on mainnet/
  );
  assert.equal(ML_DSA_MAINNET.CODE_HASH, null);
});

test("getMlDsaConstants throws on unknown network", () => {
  assert.throws(
    () => getMlDsaConstants("sepolia"),
    /Unknown CKB network/
  );
});
