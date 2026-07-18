import {
  codec,
  evaluateContactProfile,
  formatFingerprint,
  validateRotationChain,
} from "@cemp/core";
import type { ProfileTrustView } from "@cemp/core";
import { StepFailure, resolveLiveProfile } from "./shared.js";
import type { StepFn } from "./shared.js";

/**
 * verify-rotation — Bob's trust evaluation of Alice's rotated profile
 * (Phase 5 exit criteria): with ONLY the retired profile's material saved
 * (as if recorded at first contact), resolving the NEW profile must yield a
 * `rotation-verified` verdict from a structurally valid chain — and the
 * fingerprint change is surfaced for out-of-band confirmation, exactly like
 * an unexpected key change but WITH a valid chain behind it.
 */
export const stepVerifyRotation: StepFn = async (ctx, log) => {
  const label = "verify-rotation";
  if (ctx.shared.steps[label] === true) {
    log("rotation already verified (checkpoint)");
    return;
  }
  const rotation = ctx.shared.rotation;
  if (rotation === null) {
    throw new StepFailure("no rotation recorded — run the rotate step first");
  }

  // Bob's saved record: the RETIRED profile's material (pre-rotation).
  const saved = {
    profileId: codec.hexToBytes(rotation.oldProfileId),
    mlDsaPublicKey: codec.hexToBytes(rotation.oldMlDsaPublicKey),
    mlKemPublicKey: codec.hexToBytes(rotation.oldKemPublicKey),
  };
  const oldView: ProfileTrustView = {
    profileId: saved.profileId,
    mlDsaPublicKey: saved.mlDsaPublicKey,
    mlKemPublicKey: saved.mlKemPublicKey,
    rotationSequence: 0,
    previousProfileId: null,
    revoked: false,
  };

  // Resolve the NEW profile on-chain and re-check every field (rule 4).
  const resolved = await resolveLiveProfile(ctx.client, rotation.newProfileId);
  const fetched = resolved.profile;
  const newView: ProfileTrustView = {
    profileId: codec.hexToBytes(rotation.newProfileId),
    mlDsaPublicKey: fetched.ml_dsa_public_key,
    mlKemPublicKey: fetched.ml_kem_public_key,
    rotationSequence: Number(fetched.rotation_sequence),
    previousProfileId:
      fetched.previous_profile_id === undefined ? null : fetched.previous_profile_id,
    revoked: fetched.revoked !== 0,
  };

  // The structural chain check, then the contact-trust verdict.
  const chain = [oldView, newView];
  const chainResult = validateRotationChain(chain);
  if (!chainResult.valid) {
    throw new StepFailure(`rotation chain invalid: ${chainResult.reason ?? "?"}`);
  }
  const verdict = evaluateContactProfile(saved, newView, chain);
  if (verdict.verdict !== "rotation-verified") {
    throw new StepFailure(`expected rotation-verified, got ${verdict.verdict}`);
  }

  const oldFingerprint = formatFingerprint({
    profileId: oldView.profileId,
    mlDsaPublicKey: oldView.mlDsaPublicKey,
    mlKemPublicKey: oldView.mlKemPublicKey,
  });
  const newFingerprint = formatFingerprint({
    profileId: newView.profileId,
    mlDsaPublicKey: newView.mlDsaPublicKey,
    mlKemPublicKey: newView.mlKemPublicKey,
  });
  log(`rotation-verified ✓ — alice's keys rotated with a valid chain`);
  log(`  old fingerprint: ${oldFingerprint}`);
  log(`  new fingerprint: ${newFingerprint}`);
  log(
    "  the chain proves continuity; in the app, a fingerprint change like " +
      "this prompts out-of-band confirmation (not a blocking warning — the " +
      "chain cleared it).",
  );

  ctx.shared.steps[label] = true;
  ctx.save();
};
