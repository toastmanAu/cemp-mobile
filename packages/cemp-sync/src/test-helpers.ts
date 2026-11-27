/**
 * Test-only support for ADR 0007 sync tests: a deterministic v3 sender with
 * an on-chain profile cell bound to its ML-DSA lock, a transport wrapper that
 * answers the resolver's profile lookups and the funding-lock transaction
 * reads, and the resolver/disposition wiring. Not exported from index.ts.
 */

import { Script, fixedPointFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import {
  AuthenticatedSenderResolver,
  TYPE_ID_CODE_HASH,
  type JsonRpcTransport,
  type CempClient,
} from "@cemp/ckb";
import { deriveIdentityKeys, mldsaV2LockArgs, type IdentityKeyBundle } from "@cemp/crypto";
import type { ContactRepository } from "@cemp/database";
import { contactPinnedSenderLookup } from "./ingest.js";

const MLDSA_LOCK = CKB_TESTNET.deployments.mlDsaLock!;

function fillHex(byte: number, length: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(length)}`;
}

/** A sender identity with its published profile (indexer JSON). */
export interface TestSender {
  readonly keys: IdentityKeyBundle;
  readonly profileId: Uint8Array;
  readonly profileCellJson: Record<string, unknown>;
}

/** Deterministic sender from a one-byte seed fill (TEST ONLY keys). */
export function makeTestSender(seedByte: number, profileId: Uint8Array): TestSender {
  return testSenderFromKeys(
    deriveIdentityKeys(new Uint8Array(64).fill(seedByte)),
    profileId,
    seedByte,
  );
}

/** A sender around existing TEST keys; `outPointByte` names its profile cell. */
export function testSenderFromKeys(
  keys: IdentityKeyBundle,
  profileId: Uint8Array,
  outPointByte: number,
): TestSender {
  const seedByte = outPointByte;
  const lock = {
    codeHash: MLDSA_LOCK.codeHash,
    hashType: MLDSA_LOCK.hashType,
    args: hexFrom(mldsaV2LockArgs(keys.mlDsa.publicKey)),
  };
  const lockHash = Script.from(lock).hash();
  const data = codec.encodeCempProfileV1({
    ...codec.buildProfileMinimal(),
    ml_dsa_public_key: keys.mlDsa.publicKey,
    ml_kem_public_key: keys.mlKem.publicKey,
    lock_script_hash: codec.hexToBytes(lockHash.slice(2)),
  });
  return {
    keys,
    profileId,
    profileCellJson: {
      out_point: { tx_hash: fillHex(seedByte, 32), index: "0x0" },
      output: {
        capacity: `0x${fixedPointFrom(4000).toString(16)}`,
        lock: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args },
        type: { code_hash: TYPE_ID_CODE_HASH, hash_type: "type", args: hexFrom(profileId) },
      },
      output_data: hexFrom(data),
      block_number: "0x1",
    },
  };
}

/** A transaction body whose first input's source output has `lockArgs`. */
function transactionJson(): Record<string, unknown> {
  return {
    version: "0x0",
    cell_deps: [],
    header_deps: [],
    inputs: [{ previous_output: { tx_hash: fillHex(0xf0, 32), index: "0x0" }, since: "0x0" }],
    outputs: [
      {
        capacity: "0x0",
        lock: { code_hash: fillHex(0x77, 32), hash_type: "type", args: `0x${"42".repeat(37)}` },
        type: null,
      },
    ],
    outputs_data: ["0x"],
    witnesses: [],
  };
}

/**
 * Wrap a test transport: Type-ID `get_cells` queries return the matching
 * sender profile cell (or nothing), and `get_transaction` carries a body so
 * the funding-lock lookup works. Everything else is delegated.
 */
export function withSenderProfiles(
  inner: JsonRpcTransport,
  senders: readonly TestSender[],
  options: { failProfileLookups?: () => boolean } = {},
): JsonRpcTransport {
  return {
    async call(url, method, params) {
      if (method === "get_cells") {
        const searchKey = (params as unknown[])[0] as {
          script?: { code_hash?: string; args?: string };
        };
        if (searchKey.script?.code_hash === TYPE_ID_CODE_HASH) {
          if (options.failProfileLookups?.() === true) {
            throw new Error("fetch failed: indexer unavailable");
          }
          const match = senders.filter(
            (s) => hexFrom(s.profileId) === searchKey.script?.args?.toLowerCase(),
          );
          return { objects: match.map((s) => s.profileCellJson), last_cursor: "0x" };
        }
      }
      const result = (await inner.call(url, method, params)) as unknown;
      if (method === "get_transaction" && typeof result === "object" && result !== null) {
        return { transaction: transactionJson(), ...(result as Record<string, unknown>) };
      }
      return result;
    },
  };
}

/** The production resolver over the test client and contacts table. */
export function makeTestResolver(
  client: CempClient,
  contacts: ContactRepository,
): AuthenticatedSenderResolver {
  return new AuthenticatedSenderResolver({
    chain: client,
    contacts: contactPinnedSenderLookup(contacts),
    mlDsaLock: { codeHash: MLDSA_LOCK.codeHash, hashType: MLDSA_LOCK.hashType },
  });
}
