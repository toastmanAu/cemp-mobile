/**
 * AuthenticatedSenderResolver (ADR 0007 §5): who sent a decrypted v3
 * message? Returns a verdict, never a bare boolean.
 *
 * | Case                                             | Verdict                       |
 * | ------------------------------------------------ | ----------------------------- |
 * | known contact, signature valid under pinned key  | trusted                       |
 * | pinned key fails; live profile is a provable     | rotation-verified (re-pin)    |
 * |   rotation of the pinned key                     |                               |
 * | pinned key fails; key changed without proof      | key-changed-blocking          |
 * | unknown sender; live profile bound to its ML-DSA | unknown-signed (pin the key)  |
 * |   lock, signature valid                          |                               |
 * | signature invalid / profile missing or unbound   | rejected                      |
 * | any RPC or indexer failure                       | deferred (retry; never shown) |
 *
 * Transport failures are always `deferred`: an RPC error is never turned
 * into a negative answer, nor a negative answer into a positive one. To keep
 * that distinction honest, every chain read happens in a FETCH step whose
 * only failure mode is `deferred`; all judgement runs afterwards on the data.
 *
 * Display names are never an input. The only identity inputs are the
 * claimed profile id (inside the signed transcript), pinned keys from the
 * local contacts table, and on-chain profile cells and transactions.
 */

import { ckbHash, codec } from "@cemp/core";
import { mldsaV2LockArgs, verifyEnvelopeV3, type OpenedEnvelopeV3 } from "@cemp/crypto";
import { TYPE_ID_CODE_HASH } from "./builders.js";
import type { CempClient } from "./client.js";
import {
  checkResolvedProfileBinding,
  fetchProfileCells,
  selectLiveProfile,
  type ResolvedProfile,
} from "./profiles.js";
import { checkRotationLink } from "./rotation-verify.js";
import type { HashType, OutPoint, Transaction } from "./types.js";

/** Chain reads the resolver needs (a `CempClient` satisfies this). */
export type SenderChainView = Pick<CempClient, "findCells" | "getTransactionBody">;

/** A local contact as the resolver sees it: id, profile id, pinned key. */
export interface PinnedSender {
  readonly contactId: number;
  /** 32-byte profile id, lowercase hex without 0x. */
  readonly profileIdHex: string;
  /** Pinned ML-DSA-65 public key, or null when none was ever pinned. */
  readonly mlDsaPublicKey: Uint8Array | null;
}

export interface PinnedSenderLookup {
  findByProfileId(profileIdHex: string): Promise<PinnedSender | undefined>;
}

export interface AuthenticatedSenderResolverDeps {
  readonly chain: SenderChainView;
  readonly contacts: PinnedSenderLookup;
  /** The network's deployed ML-DSA lock (`{codeHash, hashType}`). */
  readonly mlDsaLock: { readonly codeHash: string; readonly hashType: HashType };
}

interface VerifiedKey {
  readonly senderProfileIdHex: string;
  readonly verifyingKey: Uint8Array;
  /** ckbHash(verifying key), lowercase hex: stored per message (ADR §5). */
  readonly verifyingKeyHashHex: string;
}

export type SenderVerdict =
  | ({ readonly kind: "trusted"; readonly contactId: number } & VerifiedKey)
  | ({
      readonly kind: "rotation-verified";
      /** The contact whose pinned key authorized the rotation. */
      readonly contactId: number;
      readonly previousProfileIdHex: string;
      readonly profile: codec.CempProfileV1;
    } & VerifiedKey)
  | ({
      readonly kind: "unknown-signed";
      /** An existing contact row with this profile id and no pinned key. */
      readonly contactId: number | null;
      readonly profile: codec.CempProfileV1;
    } & VerifiedKey)
  | {
      readonly kind: "key-changed-blocking";
      readonly contactId: number;
      readonly claimedSenderProfileIdHex: string;
      readonly reason: string;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | {
      readonly kind: "deferred";
      readonly reason: string;
      /** The node answered "no such profile": counts toward giving up. */
      readonly notFound?: true;
    };

const MAX_ROTATION_INPUTS = 32;

function hex(bytes: Uint8Array): string {
  return codec.bytesToHex(bytes);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Fetched<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** Run one chain read; any throw is a transport failure → deferred. */
async function fetchStep<T>(label: string, read: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, reason: `${label} failed: ${errorText(e)}` };
  }
}

export class AuthenticatedSenderResolver {
  readonly #deps: AuthenticatedSenderResolverDeps;

  constructor(deps: AuthenticatedSenderResolverDeps) {
    this.#deps = deps;
  }

  /** Resolve the sender of a decrypted v3 message (signature not yet checked). */
  async resolve(opened: OpenedEnvelopeV3): Promise<SenderVerdict> {
    const claimed = hex(opened.inner.sender_profile_id);
    const signed = (key: Uint8Array): boolean =>
      verifyEnvelopeV3(key, opened.transcript, opened.inner.signature);
    const contact = await this.#deps.contacts.findByProfileId(claimed);

    if (contact?.mlDsaPublicKey != null) {
      if (signed(contact.mlDsaPublicKey)) {
        return {
          kind: "trusted",
          contactId: contact.contactId,
          ...keyFacts(claimed, contact.mlDsaPublicKey),
        };
      }
      return this.#pinnedKeyFailed(claimed, contact, signed);
    }

    const live = await this.#liveBoundProfile(claimed);
    if (live.kind !== "ok") return live.verdict;
    const key = live.resolved.profile.ml_dsa_public_key;
    if (!signed(key)) {
      return {
        kind: "rejected",
        reason: "signature does not verify under the sender's live profile key",
      };
    }
    const rotated = await this.#rotationFromPinnedContact(claimed, live.resolved);
    if (rotated !== null) return rotated;
    return {
      kind: "unknown-signed",
      contactId: contact?.contactId ?? null,
      profile: live.resolved.profile,
      ...keyFacts(claimed, key),
    };
  }

  /** Known contact, pinned key does not verify (ADR §5 row 2). */
  async #pinnedKeyFailed(
    claimed: string,
    contact: PinnedSender,
    signed: (key: Uint8Array) => boolean,
  ): Promise<SenderVerdict> {
    const live = await this.#liveBoundProfile(claimed);
    if (live.kind !== "ok") return live.verdict;
    const liveKey = live.resolved.profile.ml_dsa_public_key;
    if (contact.mlDsaPublicKey !== null && codec.bytesEqual(liveKey, contact.mlDsaPublicKey)) {
      // The pinned key IS the live key and it does not verify: a forgery.
      return { kind: "rejected", reason: "signature does not verify under the pinned key" };
    }
    if (!signed(liveKey)) {
      return {
        kind: "rejected",
        reason: "signature verifies under neither the pinned nor the live key",
      };
    }
    // Same profile id, different key, valid under the new key. A rotation in
    // this protocol always mints a NEW profile id (buildRotateProfileTx), so
    // an in-place key change has no provable rotation link: block.
    return {
      kind: "key-changed-blocking",
      contactId: contact.contactId,
      claimedSenderProfileIdHex: claimed,
      reason: "the contact's profile now publishes a different key with no provable rotation",
    };
  }

  /** Fetch (→ deferred on failure), then validate and bind (→ rejected). */
  async #liveBoundProfile(
    claimed: string,
  ): Promise<
    { kind: "ok"; resolved: ResolvedProfile } | { kind: "verdict"; verdict: SenderVerdict }
  > {
    const fetched = await fetchStep("profile lookup", () =>
      fetchProfileCells(this.#deps.chain, claimed),
    );
    if (!fetched.ok) {
      return { kind: "verdict", verdict: { kind: "deferred", reason: fetched.reason } };
    }
    if (fetched.value.length === 0) {
      // "Not found" may be indexer lag on a freshly published profile, so it
      // defers (bounded backoff) instead of rejecting for good. Nothing is
      // shown or acked while deferred, so this is never a downgrade.
      return {
        kind: "verdict",
        verdict: {
          kind: "deferred",
          reason: "no live profile cell for the claimed sender (yet)",
          notFound: true,
        },
      };
    }
    let resolved: ResolvedProfile;
    try {
      resolved = selectLiveProfile(fetched.value, claimed);
      checkResolvedProfileBinding(resolved, claimed);
    } catch (e) {
      return { kind: "verdict", verdict: { kind: "rejected", reason: errorText(e) } };
    }
    const lockProblem = this.#lockBindingProblem(resolved, resolved.profile.ml_dsa_public_key);
    if (lockProblem !== null) {
      return { kind: "verdict", verdict: { kind: "rejected", reason: lockProblem } };
    }
    if (resolved.profile.revoked !== 0) {
      return {
        kind: "verdict",
        verdict: { kind: "rejected", reason: "the sender's profile is revoked" },
      };
    }
    return { kind: "ok", resolved };
  }

  /**
   * The profile key must control the profile cell: its lock is the network's
   * ML-DSA lock and the args equal `mldsaV2LockArgs(ml_dsa_public_key)`.
   * Without this a profile could advertise someone else's key (ADR §5).
   */
  #lockBindingProblem(
    owner: {
      readonly cell: {
        readonly output: { readonly lock: { codeHash: string; hashType: string; args: string } };
      };
    },
    key: Uint8Array,
  ): string | null {
    const lock = owner.cell.output.lock;
    const expected = this.#deps.mlDsaLock;
    if (
      lock.codeHash.toLowerCase() !== expected.codeHash.toLowerCase() ||
      lock.hashType !== expected.hashType
    ) {
      return "the profile cell is not locked by the ML-DSA lock";
    }
    if (lock.args.toLowerCase() !== `0x${hex(mldsaV2LockArgs(key))}`) {
      return "the profile key does not match the profile cell's lock args";
    }
    return null;
  }

  /**
   * If the live profile names a predecessor that is a pinned contact, the
   * rotation must be provable on chain from the PINNED key: the successor's
   * creating tx consumed a profile cell of the predecessor id that was
   * locked by the pinned key's ML-DSA lock. Returns null when the
   * predecessor is not a pinned contact (then this is an unknown sender).
   * Single hop only; a longer chain is not provable here and blocks.
   */
  async #rotationFromPinnedContact(
    claimed: string,
    successor: ResolvedProfile,
  ): Promise<SenderVerdict | null> {
    const previous = successor.profile.previous_profile_id;
    if (previous === undefined) return null;
    const predecessor = await this.#deps.contacts.findByProfileId(hex(previous));
    if (predecessor?.mlDsaPublicKey == null) return null;
    const pinnedKey = predecessor.mlDsaPublicKey;
    const blocking = (reason: string): SenderVerdict => ({
      kind: "key-changed-blocking",
      contactId: predecessor.contactId,
      claimedSenderProfileIdHex: claimed,
      reason,
    });

    const creating = await fetchStep("rotation tx lookup", () =>
      this.#deps.chain.getTransactionBody(successor.cell.outPoint.txHash),
    );
    if (!creating.ok) return { kind: "deferred", reason: creating.reason };
    if (creating.value === null) {
      return {
        kind: "deferred",
        reason: "node does not know the successor's creating transaction",
      };
    }
    if (creating.value.inputs.length > MAX_ROTATION_INPUTS) {
      return blocking("rotation transaction has too many inputs to verify");
    }
    const consumed = await this.#consumedPredecessor(creating.value, hex(previous));
    if (consumed.kind === "deferred") return { kind: "deferred", reason: consumed.reason };
    if (consumed.kind === "none") {
      return blocking(
        "the successor's creating transaction did not consume the pinned profile cell",
      );
    }
    if (this.#lockBindingProblem({ cell: { output: consumed.output } }, pinnedKey) !== null) {
      return blocking("the consumed predecessor cell was not controlled by the pinned key");
    }
    try {
      checkRotationLink(
        creating.value,
        { outPoint: consumed.outPoint, profileIdHex: `0x${hex(previous)}` },
        successor,
      );
    } catch (e) {
      return blocking(errorText(e));
    }
    return {
      kind: "rotation-verified",
      contactId: predecessor.contactId,
      previousProfileIdHex: hex(previous),
      profile: successor.profile,
      ...keyFacts(claimed, successor.profile.ml_dsa_public_key),
    };
  }

  /** Find the input of `tx` that spent a Type ID cell with args = `predecessorHex`. */
  async #consumedPredecessor(
    tx: Transaction,
    predecessorHex: string,
  ): Promise<
    | { kind: "found"; outPoint: OutPoint; output: Transaction["outputs"][number] }
    | { kind: "none" }
    | { kind: "deferred"; reason: string }
  > {
    for (const input of tx.inputs) {
      const source = await fetchStep("rotation input lookup", () =>
        this.#deps.chain.getTransactionBody(input.previousOutput.txHash),
      );
      if (!source.ok) return { kind: "deferred", reason: source.reason };
      if (source.value === null) continue; // unknown input: cannot be the predecessor
      let index: number;
      try {
        index = Number(BigInt(input.previousOutput.index));
      } catch {
        continue;
      }
      const output = source.value.outputs[index];
      if (
        output?.type != null &&
        output.type.codeHash.toLowerCase() === TYPE_ID_CODE_HASH.toLowerCase() &&
        output.type.args.toLowerCase() === `0x${predecessorHex}`
      ) {
        return { kind: "found", outPoint: input.previousOutput, output };
      }
    }
    return { kind: "none" };
  }
}

function keyFacts(senderProfileIdHex: string, verifyingKey: Uint8Array): VerifiedKey {
  return {
    senderProfileIdHex,
    verifyingKey,
    verifyingKeyHashHex: hex(ckbHash(verifyingKey)),
  };
}
