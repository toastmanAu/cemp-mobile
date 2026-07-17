/**
 * {@link PublicationStore} over the cemp-database repositories (spec Phase 7).
 *
 * The publisher (@cemp/ckb) owns the pipeline; this adapter owns persistence:
 * message state transitions through the §11 state machine, chain refs, and
 * the pre-broadcast outgoing-transaction journal. Type-only dependency on
 * @cemp/ckb — there is no runtime import cycle (cemp-ckb never imports this
 * package).
 */

import type { OutgoingTxRecord, PublicationStore } from "@cemp/ckb";
import type { MessageState } from "../message-states.js";
import type { MessageRepository } from "./messages.js";
import type { OutgoingTransactionRepository } from "./outgoing-transactions.js";

export class DatabasePublicationStore implements PublicationStore {
  readonly #messages: MessageRepository;
  readonly #outgoingTxs: OutgoingTransactionRepository;

  constructor(messages: MessageRepository, outgoingTxs: OutgoingTransactionRepository) {
    this.#messages = messages;
    this.#outgoingTxs = outgoingTxs;
  }

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

  async recordOutgoingTx(input: {
    txHash: string;
    purpose: string;
    state: string;
    feeShannon?: string | undefined;
    submittedAtMs?: number | undefined;
  }): Promise<void> {
    await this.#outgoingTxs.record(input);
  }

  async markOutgoingTxState(txHash: string, state: string, committedAtMs?: number): Promise<void> {
    await this.#outgoingTxs.markState(txHash, state, {
      ...(committedAtMs === undefined ? {} : { committedAtMs }),
    });
  }

  async findOutgoingTxByPurpose(purpose: string): Promise<OutgoingTxRecord | undefined> {
    const latest = await this.#outgoingTxs.findLatestByPurpose(purpose);
    return latest === undefined ? undefined : { txHash: latest.txHash, state: latest.state };
  }
}
