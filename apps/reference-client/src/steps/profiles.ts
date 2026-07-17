import { bytesFrom } from "@ckb-ccc/core";
import { codec } from "@cemp/core";
import { buildCreateProfileTx } from "@cemp/ckb";
import { StepFailure, broadcastAndCheckpoint, formatCkb, resolveLiveProfile } from "./shared.js";
import type { StepFn } from "./shared.js";
import type { IdentityName } from "../identities.js";

/**
 * profiles — create both Profile Cells (protocol spec §5): lock = owner's
 * ML-DSA-65 v2 lock, type = Type ID (its args are the profile_id), data =
 * CempProfileV1 (v1 algorithms, supported_protocol_versions [1], handle,
 * key_created_at now, rotation_sequence 0, revoked 0). The computed
 * `hashTypeId` profile id is verified against the committed on-chain cell.
 */

interface ProfilePending extends Record<string, unknown> {
  profileId: string;
  capacity: string;
  fee: string;
  kemPublicKey: string;
}

export const stepProfiles: StepFn = async (ctx, log) => {
  for (const name of ["alice", "bob"] as const) {
    await createProfile(ctx, name, log);
  }
  log(
    `profile ids — alice: ${ctx.shared.profiles.alice?.profileId ?? "?"}, ` +
      `bob: ${ctx.shared.profiles.bob?.profileId ?? "?"}`,
  );
};

async function createProfile(
  ctx: Parameters<StepFn>[0],
  name: IdentityName,
  log: (m: string) => void,
): Promise<void> {
  const label = `profile.${name}`;
  const identity = ctx.identities[name];

  if (ctx.shared.steps[label] === true) {
    log(`${name} profile already exists (checkpoint): ${identity.state.profileId ?? "?"}`);
    return;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const profile: codec.CempProfileV1Encodable = {
    protocol_version: 1,
    sig_algorithm: { family: 0x01, parameter: 61 }, // ML-DSA-65
    kem_algorithm: { family: 0x02, parameter: 3 }, // ML-KEM-768
    ml_dsa_public_key: identity.bundle.mlDsa.publicKey,
    ml_kem_public_key: identity.bundle.mlKem.publicKey,
    lock_script_hash: bytesFrom(identity.lockScriptHash),
    supported_protocol_versions: [1],
    supported_attachments: 0, // attachments are Phase 10
    handle: new TextEncoder().encode(identity.handle),
    icon_hash: undefined,
    key_created_at: now,
    rotation_sequence: 0,
    previous_profile_id: undefined,
    revoked: 0,
  };

  const result = await broadcastAndCheckpoint<ProfilePending>(
    ctx,
    label,
    log,
    async () => {
      const built = await buildCreateProfileTx({ profile, signer: identity.signer });
      const typeArgs = built.tx.outputs[0]!.type?.args;
      if (typeArgs === undefined) {
        throw new StepFailure("internal: built profile output has no type script");
      }
      const capacity = built.tx.outputs[0]!.capacity;
      log(
        `${name} profile cell: capacity ${formatCkb(capacity)} CKB, ` +
          `profile id (hashTypeId) ${typeArgs}`,
      );
      return {
        built,
        signer: identity.signer,
        metadata: {
          identity: name,
          profileId: typeArgs,
          capacity: capacity.toString(),
          handle: identity.handle,
        },
        pendingData: {
          profileId: typeArgs.slice(2),
          capacity: capacity.toString(),
          fee: built.estimatedFee.toString(),
          kemPublicKey: codec.bytesToHex(identity.bundle.mlKem.publicKey),
        },
      };
    },
    async (committed) => {
      // Verify on-chain: the committed cell's type args ARE the profile id.
      const resolved = await resolveLiveProfile(ctx.client, committed.profileId);
      if (resolved.cell.output.type?.args !== `0x${committed.profileId}`) {
        throw new StepFailure(
          `on-chain profile cell type args do not match the computed profile id ${committed.profileId}`,
        );
      }
      ctx.shared.profiles[name] = {
        profileId: committed.profileId,
        kemPublicKey: committed.kemPublicKey,
        capacity: committed.capacity,
      };
      identity.state.profileId = committed.profileId;
      identity.state.profileOutPoint = { txHash: committed.txHash, index: "0x0" };
      identity.state.profileCapacity = committed.capacity;
      identity.state.fees.profile = committed.fee;
      ctx.save();
      log(`${name} profile committed: ${committed.txHash} (profile id ${committed.profileId})`);
    },
  );
  if (!result.skipped) {
    log(`${name} profile creation done.`);
  }
}
