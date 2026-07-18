/**
 * {@link PublicationStore} + {@link LifecycleStore} over the cemp-database
 * repositories (spec Phases 7–8).
 *
 * The pipelines (@cemp/ckb) own the flows; this adapter owns persistence:
 * message state transitions through the §11 state machine, chain refs, the
 * pre-broadcast outgoing-transaction journal, watched outpoints and balance
 * accounting. Type-only dependency on @cemp/ckb — there is no runtime import
 * cycle (cemp-ckb never imports this package).
 */

import type { LifecycleStore, LifecycleWatch, PublicationStore } from "@cemp/ckb";
import { DatabaseError } from "../errors.js";
import type { MessageState } from "../message-states.js";
import type { BalanceRepository } from "./balances.js";
import type { MessageRepository } from "./messages.js";
import type { OutgoingTransactionRepository } from "./outgoing-transactions.js";
import type { WatchedOutpointRepository } from "./watched-outpoints.js";

/** Extra repositories the Phase 8 lifecycle methods need. */
export interface LifecycleRepos {
  readonly watchedOutpoints: WatchedOutpointRepository;
  readonly balances: BalanceRepository;
  /** Wallet whose balance row carries the capacity accounting. */
  readonly walletId: number;
}

export class DatabasePublicationStore implements PublicationStore, LifecycleStore {
  readonly #messages: MessageRepository;
  readonly #outgoingTxs: OutgoingTransactionRepository;
  readonly #lifecycle: LifecycleRepos | null;

  constructor(
    messages: MessageRepository,
    outgoingTxs: OutgoingTransactionRepository,
    lifecycle?: LifecycleRepos,
  ) {
    this.#messages = messages;
    this.#outgoingTxs = outgoingTxs;
    this.#lifecycle = lifecycle ?? null;
  }

  #requireLifecycle(): LifecycleRepos {
    if (this.#lifecycle === null) {
      throw new DatabaseError(
        "adapter-error",
        "lifecycle repositories were not configured on this store",
      );
    }
    return this.#lifecycle;
  }

  /* ------------------------------------------------ publication (P7) -- */

  async transitionMessage(messageRowId: number, to: string): Promise<void> {
    await this.#messages.transitionState(messageRowId, to as MessageState);
  }

  async setMessageChainRef(
    messageRowId: number,
    ref: { txHash: string; outpointIndex: number },
  ): Promise<void> {
    await this.#messages.setChainRef(messageRowId, {
      txHash: ref.txHash,
      outpointIndex: ref.outpointIndex,
    });
  }

  async setEnvelopeMessageId(messageRowId: number, envelopeMessageIdHex: string): Promise<void> {
    await this.#messages.setEnvelopeMessageId(messageRowId, envelopeMessageIdHex);
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
    await this.#outgoingTxs.record(input);
  }

  async markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void> {
    await this.#outgoingTxs.markState(txHash, state, {
      ...(committedAtMs === undefined ? {} : { committedAtMs }),
    });
  }

  async findOutgoingTxByPurpose(
    purpose: string,
  ): Promise<
    | { txHash: string; state: string; txHex: string | null; capacityShannon: string | null }
    | undefined
  > {
    const latest = await this.#outgoingTxs.findLatestByPurpose(purpose);
    return latest === undefined
      ? undefined
      : {
          txHash: latest.txHash,
          state: latest.state,
          txHex: latest.txHex,
          capacityShannon: latest.capacityShannon,
        };
  }

  /* -------------------------------------------------- lifecycle (P8) -- */

  async findOutgoingByEnvelopeMessageId(
    envelopeMessageIdHex: string,
  ): Promise<{ rowId: number; state: string } | undefined> {
    const message = await this.#messages.getByEnvelopeMessageId(envelopeMessageIdHex);
    return message === undefined ? undefined : { rowId: message.id, state: message.state };
  }

  async listOutgoingByState(
    state: string,
  ): Promise<
    { rowId: number; state: string; chainRef: { txHash: string; outpointIndex: number } | null }[]
  > {
    const messages = await this.#messages.listByState([state as MessageState]);
    const result = [];
    for (const message of messages) {
      const chainRef = await this.#messages.getChainRef(message.id);
      result.push({
        rowId: message.id,
        state: message.state,
        chainRef:
          chainRef === undefined || chainRef.txHash === null || chainRef.outpointIndex === null
            ? null
            : { txHash: chainRef.txHash, outpointIndex: chainRef.outpointIndex },
      });
    }
    return result;
  }

  async findLatestOutgoingTxByPurposePrefix(prefix: string): Promise<
    | {
        txHash: string;
        state: string;
        purpose: string;
        capacityShannon: string | null;
        feeShannon: string | null;
        txHex: string | null;
      }
    | undefined
  > {
    const latest = await this.#outgoingTxs.findLatestByPurposePrefix(prefix);
    if (latest === undefined) {
      return undefined;
    }
    return {
      txHash: latest.txHash,
      state: latest.state,
      purpose: latest.purpose,
      capacityShannon: latest.capacityShannon,
      feeShannon: latest.feeShannon,
      txHex: latest.txHex,
    };
  }

  async markOutgoingTxStateIf(
    txHash: string,
    expectedFromState: string,
    state: string,
    committedAtMs?: number,
  ): Promise<number> {
    return await this.#outgoingTxs.markStateIf(txHash, expectedFromState, state, {
      ...(committedAtMs === undefined ? {} : { committedAtMs }),
    });
  }

  async reserveCapacity(amountShannon: string): Promise<void> {
    const { balances, walletId } = this.#requireLifecycle();
    await balances.reserveCapacity(walletId, BigInt(amountShannon));
  }

  async markCapacityReclaimable(amountShannon: string): Promise<void> {
    const { balances, walletId } = this.#requireLifecycle();
    await balances.markReclaimable(walletId, BigInt(amountShannon));
  }

  async getMessageJournalInfo(
    rowId: number,
  ): Promise<{ logicalMessageId: string; capacityShannon: string | null } | undefined> {
    const message = await this.#messages.getById(rowId);
    if (message === undefined) {
      return undefined;
    }
    const journal = await this.#outgoingTxs.findLatestByPurpose(
      `message:${message.logicalMessageId}`,
    );
    return {
      logicalMessageId: message.logicalMessageId,
      capacityShannon: journal?.capacityShannon ?? null,
    };
  }

  async registerWatch(input: {
    txHash: string;
    outpointIndex: number;
    purpose: string;
  }): Promise<void> {
    const { watchedOutpoints } = this.#requireLifecycle();
    await watchedOutpoints.register(input);
  }

  async listActiveWatches(): Promise<LifecycleWatch[]> {
    const { watchedOutpoints } = this.#requireLifecycle();
    const active = await watchedOutpoints.listActive();
    return active.map((watch) => ({
      txHash: watch.txHash,
      outpointIndex: watch.outpointIndex,
      purpose: watch.purpose,
    }));
  }

  async markWatchSpent(
    txHash: string,
    outpointIndex: number,
    spentByTxHash: string,
  ): Promise<void> {
    const { watchedOutpoints } = this.#requireLifecycle();
    await watchedOutpoints.markSpent(txHash, outpointIndex, spentByTxHash);
  }

  async pruneSpentWatches(): Promise<number> {
    const { watchedOutpoints } = this.#requireLifecycle();
    return watchedOutpoints.pruneSpent();
  }

  async releaseReclaimedCapacity(amountShannon: string): Promise<void> {
    const { balances, walletId } = this.#requireLifecycle();
    await balances.releaseReclaimedCapacity(walletId, BigInt(amountShannon));
  }

  async recordFeeBurn(amountShannon: string): Promise<void> {
    const { balances, walletId } = this.#requireLifecycle();
    await balances.recordFeeBurn(walletId, BigInt(amountShannon));
  }
}
