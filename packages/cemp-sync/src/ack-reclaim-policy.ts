/**
 * When may a responder reclaim its own acknowledgement cell? (ADR 0008)
 *
 * An ack (`response:` 0x01 or `ack-attachment:` 0x05) is an outgoing message
 * cell funded by the RECIPIENT of the original. Acks are never re-acked
 * (ADR 0005, which is what ends the exchange), so the normal
 * `acknowledged → reclaim_queued` path never fires for them. Without this
 * policy every ack's capacity stays locked forever.
 */

/**
 * Fallback age after which an ack is reclaimed even with no proof the sender
 * consumed it. Deliberately generous: reclaiming an ack the sender has not
 * yet read means the sender never sees it, and then never reclaims its OWN
 * cell (message or image chunks). 30 days covers a phone left in a drawer,
 * and matches the routing epoch length.
 */
export const ACK_RECLAIM_FALLBACK_MS = 30 * 24 * 60 * 60 * 1000;

export interface AckReclaimEvidence {
  /**
   * The sender provably processed the ack: it spent the cell it only spends
   * AFTER reading this ack (the message cell for 0x01, a chunk cell for 0x05).
   */
  readonly senderConsumedAck: boolean;
  /** When the ack's own transaction committed (local clock, ms). */
  readonly ackCommittedAtMs: number;
  readonly nowMs: number;
}

/** Reclaim on proof of consumption, or once the ack is older than the fallback. */
export function shouldReclaimAck(evidence: AckReclaimEvidence): boolean {
  if (evidence.senderConsumedAck) {
    return true;
  }
  // A clock reading earlier than the commit (skew, or a reset clock) gives a
  // negative age, which never satisfies the bound: fail towards keeping.
  return evidence.nowMs - evidence.ackCommittedAtMs >= ACK_RECLAIM_FALLBACK_MS;
}
