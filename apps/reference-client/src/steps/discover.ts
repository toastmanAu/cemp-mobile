import { bytesFrom } from "@ckb-ccc/core";
import { codec, deriveRouteTag } from "@cemp/core";
import { decryptEnvelope } from "@cemp/crypto";
import { findMessageCells } from "@cemp/ckb";
import { StepFailure, cempMessageTypeRef, currentRoutingEpoch } from "./shared.js";
import type { Ctx, RuntimeIdentity } from "./shared.js";
import type { OutPointJson } from "../state.js";

/**
 * Incoming-message discovery + decryption pipeline (spec §6.1, §12):
 * route-tag prefix scan (current AND previous routing epoch, spec §2 grace)
 * → pre-decrypt validation → ML-KEM decapsulation → payload validation →
 * semantic consistency. Invalid cells are transport noise: logged, marked
 * processed and NEVER retried (spec §12.4). Processing marks and history
 * records are saved together per cell, so a crash mid-scan replays cleanly
 * (rule 5). Plaintext is returned to the caller for stdout only — never
 * persisted (rule 3).
 */

export interface DecryptedMessage {
  outPoint: OutPointJson;
  header: codec.CempEnvelopeHeaderV1;
  payload: codec.CempPayloadV1;
  /** UTF-8 text when the payload carries it. */
  text: string | null;
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
        const decrypted = tryDecrypt(cell.data, me, ownProfileId);
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

interface DecryptedParts {
  header: codec.CempEnvelopeHeaderV1;
  payload: codec.CempPayloadV1;
  text: string | null;
}

function decryptedAt(parts: DecryptedParts, outPoint: OutPointJson): DecryptedMessage {
  return { outPoint, header: parts.header, payload: parts.payload, text: parts.text };
}

function tryDecrypt(
  dataHex: string,
  me: RuntimeIdentity,
  ownProfileId: Uint8Array,
): DecryptedParts | null {
  try {
    const envelopeBytes = bytesFrom(dataHex);
    const validation = codec.validateEnvelope(envelopeBytes);
    if (!validation.ok) {
      return null;
    }
    const { header, payloadBytes } = decryptEnvelope({
      envelopeBytes,
      recipientKemSecretKey: me.bundle.mlKem.secretKey,
      ownProfileId,
    });
    const payloadCheck = codec.validatePayload(payloadBytes);
    if (!payloadCheck.ok) {
      return null;
    }
    const payload = codec.decodeCempPayloadV1(payloadBytes);
    const semantic = codec.validateSemanticConsistency(header, payload, ownProfileId);
    if (!semantic.ok) {
      return null;
    }
    const text = payload.text === undefined ? null : new TextDecoder().decode(payload.text);
    return { header, payload, text };
  } catch {
    return null; // crypto/shape failures are transport noise (spec §12.4)
  }
}
