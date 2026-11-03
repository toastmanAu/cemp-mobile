import { bytesFrom } from "@ckb-ccc/core";
import { CKB_TESTNET, codec, deriveRouteTag } from "@cemp/core";
import { decryptEnvelope, openEnvelopeV3 } from "@cemp/crypto";
import { AuthenticatedSenderResolver, findMessageCells } from "@cemp/ckb";
import { StepFailure, cempMessageTypeRef, currentRoutingEpoch } from "./shared.js";
import type { Ctx, RuntimeIdentity } from "./shared.js";
import type { OutPointJson } from "../state.js";

/**
 * Incoming-message discovery + decryption pipeline (spec §6.1, §12):
 * route-tag prefix scan (current AND previous routing epoch, spec §2 grace)
 * → pre-decrypt validation → ML-KEM decapsulation → payload validation →
 * semantic consistency, and for protocol v3 (ADR 0007) sender
 * authentication through the production AuthenticatedSenderResolver: a v3
 * message whose signature does not verify under the sender's bound live
 * profile key is dropped. v1/v2 messages are returned with `verified:
 * false` ("Unverified (legacy)"). Invalid cells are transport noise: logged, marked
 * processed and NEVER retried (spec §12.4). Processing marks and history
 * records are saved together per cell, so a crash mid-scan replays cleanly
 * (rule 5). Plaintext is returned to the caller for stdout only — never
 * persisted (rule 3).
 */

export interface DecryptedMessage {
  outPoint: OutPointJson;
  /** The ids a caller records (from the v1 clear header, or the v3 inner plaintext). */
  header: { message_id: Uint8Array; sender_profile_id: Uint8Array };
  /** v1/v2 layout or the v3 inner payload (always CempPayloadV2 there). */
  payload: codec.CempPayloadV1 | codec.CempPayloadV2;
  /** UTF-8 text when the payload carries it. */
  text: string | null;
  /** True for a v3 message whose sender signature verified (ADR 0007). */
  verified: boolean;
}

const DISCOVERY_PAGE = 64;

export async function scanAndDecrypt(
  ctx: Ctx,
  me: RuntimeIdentity,
  log: (m: string) => void,
  onMessage: (msg: DecryptedMessage) => void,
): Promise<DecryptedMessage[]> {
  const profileId = me.state.profileId;
  if (profileId === null) {
    throw new StepFailure(`${me.name} has no profile yet — run the profiles step first`);
  }
  const typeRef = cempMessageTypeRef(ctx);
  const ownProfileId = codec.hexToBytes(profileId);
  const epoch = currentRoutingEpoch();
  const routeTags = [epoch, epoch - 1n].map((e) => deriveRouteTag(ownProfileId, e));

  const processed = new Set(me.state.processedCells);
  const found: DecryptedMessage[] = [];
  const seenOutpoints = new Set<string>();

  for (const routeTag of routeTags) {
    let cursor: string | undefined;
    for (;;) {
      const page = await findMessageCells(ctx.client, typeRef, routeTag, cursor);
      for (const cell of page.cells) {
        const outPoint: OutPointJson = {
          txHash: cell.outPoint.txHash,
          index: cell.outPoint.index,
        };
        const key = `${outPoint.txHash}:${outPoint.index}`;
        if (seenOutpoints.has(key) || processed.has(key)) {
          continue;
        }
        seenOutpoints.add(key);
        const decrypted = await tryDecrypt(ctx, cell.data, me, ownProfileId);
        me.state.processedCells.push(key);
        if (decrypted === null) {
          log(`… transport noise at ${key} failed validation/decryption — marked, not retried`);
        } else {
          onMessage(decryptedAt(decrypted, outPoint));
          found.push(decryptedAt(decrypted, outPoint));
        }
        // Save processing mark + history mutation together (crash-consistent).
        ctx.saveIdentity(me.name);
      }
      if (page.cells.length < DISCOVERY_PAGE) {
        break;
      }
      cursor = page.lastCursor;
    }
  }
  return found;
}

type DecryptedParts = Omit<DecryptedMessage, "outPoint">;

function decryptedAt(parts: DecryptedParts, outPoint: OutPointJson): DecryptedMessage {
  return { outPoint, ...parts };
}

/** The production resolver; this harness pins no keys (every sender is resolved live). */
function resolverFor(ctx: Ctx): AuthenticatedSenderResolver {
  const lock = CKB_TESTNET.deployments.mlDsaLock;
  if (lock === null) {
    throw new StepFailure("testnet ML-DSA lock deployment is not pinned");
  }
  return new AuthenticatedSenderResolver({
    chain: ctx.client,
    contacts: { findByProfileId: () => Promise.resolve(undefined) },
    mlDsaLock: { codeHash: lock.codeHash, hashType: lock.hashType },
  });
}

async function tryDecryptV3(
  ctx: Ctx,
  envelopeBytes: Uint8Array,
  me: RuntimeIdentity,
  ownProfileId: Uint8Array,
): Promise<DecryptedParts | null> {
  const opened = openEnvelopeV3({
    envelopeBytes,
    recipientKemSecretKey: me.bundle.mlKem.secretKey,
    ownProfileId,
  });
  opened.attachmentKey.fill(0);
  opened.receiptKey.fill(0);
  const verdict = await resolverFor(ctx).resolve(opened);
  if (verdict.kind !== "unknown-signed" && verdict.kind !== "trusted") {
    return null; // rejected / deferred / blocking: never shown by this harness
  }
  const payload = opened.inner.payload;
  return {
    header: { message_id: payload.message_id, sender_profile_id: opened.inner.sender_profile_id },
    payload,
    text: payload.text === undefined ? null : new TextDecoder().decode(payload.text),
    verified: true,
  };
}

async function tryDecrypt(
  ctx: Ctx,
  dataHex: string,
  me: RuntimeIdentity,
  ownProfileId: Uint8Array,
): Promise<DecryptedParts | null> {
  try {
    const envelopeBytes = bytesFrom(dataHex);
    const validation = codec.validateEnvelope(envelopeBytes);
    if (!validation.ok) {
      return null;
    }
    // ADR 0007 §4: the version byte selects the pipeline, never a fallback.
    if (codec.peekEnvelopeProtocolVersion(envelopeBytes) === 3) {
      return await tryDecryptV3(ctx, envelopeBytes, me, ownProfileId);
    }
    const { header, payloadBytes } = decryptEnvelope({
      envelopeBytes,
      recipientKemSecretKey: me.bundle.mlKem.secretKey,
      ownProfileId,
    });
    // ADR 0006: explicit dispatch on the header version, never a fallback.
    const payloadCheck = codec.validatePayloadForVersion(header.protocol_version, payloadBytes);
    if (!payloadCheck.ok) {
      return null;
    }
    const payload = codec.decodeCempPayload(header.protocol_version, payloadBytes).payload;
    const semantic = codec.validateSemanticConsistency(header, payload, ownProfileId);
    if (!semantic.ok) {
      return null;
    }
    const text = payload.text === undefined ? null : new TextDecoder().decode(payload.text);
    return { header, payload, text, verified: false };
  } catch {
    return null; // crypto/shape failures are transport noise (spec §12.4)
  }
}
