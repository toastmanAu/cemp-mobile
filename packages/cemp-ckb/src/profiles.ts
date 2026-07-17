/**
 * On-chain profile resolution (spec §5.5, Phase 7 task 2).
 *
 * Resolves a live profile cell by its Type ID and runs the full codec
 * validation pipeline on its data (rule 4: indexer output is hostile). Used
 * by the publisher before every send — a message is never encrypted to a
 * profile that fails validation.
 */

import { Script } from "@ckb-ccc/core";
import { codec } from "@cemp/core";
import { TYPE_ID_CODE_HASH } from "./builders.js";
import { CempCkbError, type CempClient } from "./client.js";
import type { Cell } from "./types.js";

export interface ResolvedProfile {
  readonly cell: Cell;
  readonly profile: codec.CempProfileV1;
}

function bareProfileId(profileIdHex: string): string {
  const bare = profileIdHex.startsWith("0x") ? profileIdHex.slice(2) : profileIdHex;
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new CempCkbError("resolveLiveProfile", "profile id must be 32-byte lowercase hex");
  }
  return bare;
}

/**
 * Resolve the unique live profile cell for `profileIdHex` (with or without
 * the 0x prefix). Throws unless EXACTLY one well-formed live cell exists —
 * Type ID uniqueness makes anything else an indexer/protocol violation.
 */
export async function resolveLiveProfile(
  client: CempClient,
  profileIdHex: string,
): Promise<ResolvedProfile> {
  const bare = bareProfileId(profileIdHex);
  const page = await client.findCells({
    script: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: `0x${bare}` },
    scriptType: "type",
    argsSearchMode: "exact",
    limit: 8,
  });
  if (page.cells.length === 0) {
    throw new CempCkbError(
      "resolveLiveProfile",
      `no live profile cell for profile id ${bare.slice(0, 12)}…`,
    );
  }
  if (page.cells.length > 1) {
    throw new CempCkbError(
      "resolveLiveProfile",
      `impossible: ${String(page.cells.length)} live cells share one profile id (Type ID uniqueness)`,
    );
  }
  const cell = page.cells[0]!;
  const data = hexToBytes(cell.data);
  const validation = codec.validateProfile(data);
  if (!validation.ok) {
    throw new CempCkbError(
      "resolveLiveProfile",
      `on-chain profile cell failed validation: ${validation.reason}`,
    );
  }
  return { cell, profile: codec.decodeCempProfileV1(data) };
}

/**
 * Binding cross-checks on a resolved profile (rule 4): the cell's type args
 * are the queried profile id, and the profile's `lock_script_hash` binds the
 * cell's actual lock. Stale/forged index entries fail here.
 */
export function checkResolvedProfileBinding(resolved: ResolvedProfile, profileIdHex: string): void {
  const bare = bareProfileId(profileIdHex);
  const typeArgs = resolved.cell.output.type?.args;
  if (typeArgs !== `0x${bare}`) {
    throw new CempCkbError(
      "resolveLiveProfile",
      "resolved cell's type args do not match the queried profile id",
    );
  }
  const lock = resolved.cell.output.lock;
  const lockHash = Script.from({
    codeHash: lock.codeHash,
    hashType: lock.hashType,
    args: lock.args,
  }).hash();
  if (`0x${bytesToHex(resolved.profile.lock_script_hash)}` !== lockHash) {
    throw new CempCkbError(
      "resolveLiveProfile",
      "profile lock_script_hash does not bind the cell's lock",
    );
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(bare.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(bare.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
