import { Script, bytesFrom, hexFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec } from "@cemp/core";
import {
  deriveRotatedIdentityKeys,
  mnemonicToSeed,
  mldsaV2LockArgs,
  wipeIdentityKeyBundle,
} from "@cemp/crypto";
import { buildRotateProfileTx } from "@cemp/ckb";
import { ALICE_MNEMONIC } from "../identities.js";
import { StepFailure, broadcastAndCheckpoint, formatCkb, resolveLiveProfile } from "./shared.js";
import type { StepFn } from "./shared.js";

/**
 * rotate — Alice rotates her profile identity keys on-chain (protocol §5.1):
 * rotation 1 keys from `deriveRotatedIdentityKeys(seed, 1)`, the CURRENT
 * profile cell is spent (signed by her current lock), and the successor cell
 * is created with a NEW Type ID and `previous_profile_id` pointing at the
 * retired profile. Verified on-chain afterwards: old cell dead, new cell
 * live with the back-reference intact. The trust evaluation lives in the
 * verify-rotation step.
 *
 * Note: rotation rotates the PROFILE's messaging keys (ML-DSA + ML-KEM); her
 * remaining wallet cells stay under the original lock — a full wallet
 * migration is an app-level concern, not part of this protocol proof.
 */

interface RotatePending extends Record<string, unknown> {
  oldProfileId: string;
  oldMlDsaPublicKey: string;
  oldKemPublicKey: string;
  newProfileId: string;
  capacity: string;
  fee: string;
  kemPublicKey: string;
}

export const stepRotate: StepFn = async (ctx, log) => {
  const label = "rotate.alice";
  if (ctx.shared.steps[label] === true) {
    log(`alice already rotated (checkpoint): ${ctx.shared.rotation?.newProfileId ?? "?"}`);
    return;
  }
  const alice = ctx.identities.alice;
  const aliceRecord = ctx.shared.profiles.alice;
  if (aliceRecord === null) {
    throw new StepFailure("alice has no profile — run the profiles step first");
  }

  // Rotation 1 identity: deterministic from the same seed (protocol §5.1).
  const seed = mnemonicToSeed(ALICE_MNEMONIC);
  let rotated;
  try {
    rotated = deriveRotatedIdentityKeys(seed, 1);
  } finally {
    seed.fill(0);
  }

  try {
    // The live profile cell being rotated away from (hostile-input checked).
    const resolved = await resolveLiveProfile(ctx.client, aliceRecord.profileId);
    const oldCell = resolved.cell;
    log(
      `rotating alice's profile ${aliceRecord.profileId.slice(0, 18)}… ` +
        `(cell ${oldCell.outPoint.txHash.slice(0, 18)}…:${oldCell.outPoint.index})`,
    );

    // The rotated identity's lock (v2 lock args over the rotated ML-DSA key).
    const mlDsaLock = CKB_TESTNET.deployments.mlDsaLock;
    if (mlDsaLock === null) {
      throw new StepFailure("ml-dsa lock deployment missing from network config");
    }
    const newLock = {
      codeHash: mlDsaLock.codeHash,
      hashType: mlDsaLock.hashType,
      args: hexFrom(mldsaV2LockArgs(rotated.mlDsa.publicKey)),
    };
    const newLockHash = Script.from(newLock).hash();

    const newProfile: codec.CempProfileV1Encodable = {
      protocol_version: 1,
      sig_algorithm: { family: 0x01, parameter: 61 },
      kem_algorithm: { family: 0x02, parameter: 3 },
      ml_dsa_public_key: rotated.mlDsa.publicKey,
      ml_kem_public_key: rotated.mlKem.publicKey,
      lock_script_hash: bytesFrom(newLockHash),
      supported_protocol_versions: [1],
      supported_attachments: 0,
      handle: new TextEncoder().encode(alice.handle),
      icon_hash: undefined,
      key_created_at: BigInt(Math.floor(Date.now() / 1000)),
      rotation_sequence: 1,
      previous_profile_id: codec.hexToBytes(aliceRecord.profileId),
      revoked: 0,
    };

    await broadcastAndCheckpoint<RotatePending>(
      ctx,
      label,
      log,
      async () => {
        const built = await buildRotateProfileTx({
          oldProfileCell: oldCell,
          newProfile,
          newLock,
          signer: alice.signer,
        });
        const newTypeArgs = built.tx.outputs[0]!.type?.args;
        if (newTypeArgs === undefined) {
          throw new StepFailure("internal: rotated profile output has no type script");
        }
        const capacity = built.tx.outputs[0]!.capacity;
        log(
          `successor profile cell: capacity ${formatCkb(capacity)} CKB, ` +
            `new profile id ${newTypeArgs}`,
        );
        return {
          built,
          signer: alice.signer,
          metadata: {
            rotation: "alice:0→1",
            oldProfileId: aliceRecord.profileId,
            newProfileId: newTypeArgs.slice(2),
          },
          pendingData: {
            oldProfileId: aliceRecord.profileId,
            oldMlDsaPublicKey: codec.bytesToHex(resolved.profile.ml_dsa_public_key),
            oldKemPublicKey: codec.bytesToHex(resolved.profile.ml_kem_public_key),
            newProfileId: newTypeArgs.slice(2),
            capacity: capacity.toString(),
            fee: built.estimatedFee.toString(),
            kemPublicKey: codec.bytesToHex(rotated.mlKem.publicKey),
          },
        };
      },
      async (committed) => {
        // On-chain verification: the OLD cell must be spent, the NEW cell
        // live with the correct rotation fields.
        const old = await ctx.client.getLiveCell(oldCell.outPoint);
        if (old.status === "live") {
          throw new StepFailure("old profile cell is still live after the rotation tx committed");
        }
        log(`old profile cell spent ✓ (${committed.txHash})`);
        const resolvedNew = await resolveLiveProfile(ctx.client, committed.newProfileId);
        const decoded = resolvedNew.profile;
        if (decoded.rotation_sequence !== 1) {
          throw new StepFailure(
            `on-chain rotation_sequence is ${String(decoded.rotation_sequence)}, expected 1`,
          );
        }
        const backRef = decoded.previous_profile_id;
        if (backRef === undefined || codec.bytesToHex(backRef) !== committed.oldProfileId) {
          throw new StepFailure("on-chain previous_profile_id does not name the retired profile");
        }
        log(`new profile live ✓ rotation_sequence=1, previous_profile_id back-references ✓`);

        ctx.shared.rotation = {
          oldProfileId: committed.oldProfileId,
          oldMlDsaPublicKey: committed.oldMlDsaPublicKey,
          oldKemPublicKey: committed.oldKemPublicKey,
          oldOutPoint: { txHash: oldCell.outPoint.txHash, index: oldCell.outPoint.index },
          newProfileId: committed.newProfileId,
          txHash: committed.txHash,
        };
        ctx.shared.profiles.alice = {
          profileId: committed.newProfileId,
          kemPublicKey: committed.kemPublicKey,
          capacity: committed.capacity,
        };
        alice.state.profileId = committed.newProfileId;
        alice.state.profileOutPoint = { txHash: committed.txHash, index: "0x0" };
        alice.state.profileCapacity = committed.capacity;
        alice.state.fees.rotate = committed.fee;
        ctx.save();
        log(
          `alice rotation committed: ${committed.txHash} (new profile id ${committed.newProfileId})`,
        );
      },
    );
  } finally {
    wipeIdentityKeyBundle(rotated);
  }
};
