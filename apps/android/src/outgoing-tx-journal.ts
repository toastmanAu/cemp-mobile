import type { BalanceRepository, OutgoingTransactionRepository } from "@cemp/database";
import type { AttachmentChunkJournal, AttachmentReclaimStore } from "@cemp/images";

/**
 * Adapts the app's OutgoingTransactionRepository to the AttachmentChunkJournal
 * the image chunk publisher expects (spec §2 step 4: chunk cells ride the same
 * journal as text). No new SQL — a shape bridge over existing methods. The
 * balance half funds the chunk-cell capacity reserve at commit (review M-1).
 */
export class OutgoingTxJournalAdapter implements AttachmentChunkJournal {
  readonly #repo: OutgoingTransactionRepository;
  readonly #balances: BalanceRepository;
  readonly #walletId: number;

  constructor(repo: OutgoingTransactionRepository, balances: BalanceRepository, walletId: number) {
    this.#repo = repo;
    this.#balances = balances;
    this.#walletId = walletId;
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

  async findLatestOutgoingTxByPurposePrefix(prefix: string): Promise<
    | {
        txHash: string;
        state: string;
        purpose: string;
        capacityShannon?: string | null;
        feeShannon?: string | null;
        txHex?: string | null;
      }
    | undefined
  > {
    return await this.#repo.findLatestByPurposePrefix(prefix);
  }

  async reserveCapacity(amountShannon: string): Promise<void> {
    await this.#balances.reserveCapacity(this.#walletId, BigInt(amountShannon));
  }
}

/**
 * The full AttachmentReclaimStore the group reclaim expects: the journal half
 * plus the capacity accounting back to the operational wallet (spec §9.5;
 * review M-1/I-6/E7). Wired in the composition root for the sync worker's
 * attachment-group reclaim pass (T17 finding F-2).
 */
export class AttachmentReclaimStoreAdapter
  extends OutgoingTxJournalAdapter
  implements AttachmentReclaimStore
{
  readonly #repo: OutgoingTransactionRepository;
  readonly #balances: BalanceRepository;
  readonly #walletId: number;

  constructor(repo: OutgoingTransactionRepository, balances: BalanceRepository, walletId: number) {
    super(repo, balances, walletId);
    this.#repo = repo;
    this.#balances = balances;
    this.#walletId = walletId;
  }

  async markOutgoingTxStateIf(
    txHash: string,
    expectedFromState: string,
    state: string,
    committedAtMs?: number,
  ): Promise<number> {
    return await this.#repo.markStateIf(
      txHash,
      expectedFromState,
      state,
      committedAtMs === undefined ? {} : { committedAtMs },
    );
  }

  async markCapacityReclaimable(amountShannon: string): Promise<void> {
    await this.#balances.markReclaimable(this.#walletId, BigInt(amountShannon));
  }

  async releaseReclaimedCapacity(amountShannon: string): Promise<void> {
    await this.#balances.releaseReclaimedCapacity(this.#walletId, BigInt(amountShannon));
  }

  async recordFeeBurn(amountShannon: string): Promise<void> {
    await this.#balances.recordFeeBurn(this.#walletId, BigInt(amountShannon));
  }
}
