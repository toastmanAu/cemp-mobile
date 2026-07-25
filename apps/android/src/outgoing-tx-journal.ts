import type { BalanceRepository, OutgoingTransactionRepository } from "@cemp/database";
import type { AttachmentChunkJournal, AttachmentReclaimStore } from "@cemp/images";

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

/**
 * The full AttachmentReclaimStore the group reclaim expects: the journal half
 * plus capacity release back to the operational wallet (spec §9.5). Wired in
 * the composition root for the sync worker's attachment-group reclaim pass
 * (T17 finding F-2).
 */
export class AttachmentReclaimStoreAdapter
  extends OutgoingTxJournalAdapter
  implements AttachmentReclaimStore
{
  readonly #balances: BalanceRepository;
  readonly #walletId: number;

  constructor(repo: OutgoingTransactionRepository, balances: BalanceRepository, walletId: number) {
    super(repo);
    this.#balances = balances;
    this.#walletId = walletId;
  }

  async releaseReclaimedCapacity(amountShannon: string): Promise<void> {
    await this.#balances.releaseReclaimedCapacity(this.#walletId, BigInt(amountShannon));
  }
}
