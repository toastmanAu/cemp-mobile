import type { OutgoingTransactionRepository } from "@cemp/database";
import type { AttachmentChunkJournal } from "@cemp/images";

/**
 * Adapts the app's OutgoingTransactionRepository to the AttachmentChunkJournal
 * the image chunk publisher expects (spec §2 step 4: chunk cells ride the same
 * journal as text). No new SQL — a shape bridge over existing methods.
 */
export class OutgoingTxJournalAdapter implements AttachmentChunkJournal {
  readonly #repo: OutgoingTransactionRepository;

  constructor(repo: OutgoingTransactionRepository) {
    this.#repo = repo;
  }

  async recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    submittedAtMs?: number | undefined;
    capacityShannon?: string | undefined;
    txHex?: string | undefined;
  }): Promise<void> {
    await this.#repo.record(input);
  }

  async markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void> {
    await this.#repo.markState(txHash, state, committedAtMs === undefined ? {} : { committedAtMs });
  }

  async findLatestOutgoingTxByPurposePrefix(
    prefix: string,
  ): Promise<{ txHash: string; state: string; purpose: string; txHex?: string | null } | undefined> {
    return await this.#repo.findLatestByPurposePrefix(prefix);
  }
}
