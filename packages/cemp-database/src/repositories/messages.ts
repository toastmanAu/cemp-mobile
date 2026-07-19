/**
 * Message repository (spec Phase 6 task 4) with the §11 state machine.
 *
 * - Insert is idempotent on `logical_message_id` (rule 5): a retry after a
 *   crash or a duplicate background worker returns the existing row instead
 *   of duplicating the message.
 * - State transitions go through {@link transitionState}, which enforces the
 *   §11 state machine: illegal transitions throw, a transition to the
 *   CURRENT state is a persisted no-op (idempotent re-application after a
 *   crash mid-transition).
 * - Listing uses keyset pagination (`id < before`) — stable under concurrent
 *   inserts, unlike OFFSET.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";
import {
  canTransitionMessage,
  initialMessageState,
  type MessageDirection,
  type MessageState,
} from "../message-states.js";

export interface Message {
  readonly id: number;
  readonly conversationId: number;
  readonly direction: MessageDirection;
  readonly state: MessageState;
  readonly body: string | null;
  readonly logicalMessageId: string;
  /** Envelope message id (schema v3; null until published/processed). */
  readonly envelopeMessageIdHex: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface MessageChainRef {
  readonly messageId: number;
  readonly txHash: string | null;
  readonly outpointIndex: number | null;
  readonly replyToTxHash: string | null;
  readonly replyToOutpointIndex: number | null;
}

function rowToMessage(row: SqlRow): Message {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    direction: String(row.direction) as MessageDirection,
    state: String(row.state) as MessageState,
    body: row.body === null || row.body === undefined ? null : String(row.body),
    logicalMessageId: String(row.logical_message_id),
    envelopeMessageIdHex:
      row.envelope_message_id_hex === null || row.envelope_message_id_hex === undefined
        ? null
        : String(row.envelope_message_id_hex),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class MessageRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /**
   * Insert a new message. `logicalMessageId` is the idempotency key: when a
   * row with the same id already exists it is returned unchanged (rule 5).
   */
  async insert(input: {
    conversationId: number;
    direction: MessageDirection;
    body?: string | null;
    logicalMessageId: string;
    state?: MessageState;
    createdAtMs?: number;
  }): Promise<Message> {
    const now = Date.now();
    const createdAt = input.createdAtMs ?? now;
    const state = input.state ?? initialMessageState(input.direction);
    const result = await this.#db.run(
      `INSERT INTO messages (conversation_id, direction, state, body, logical_message_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (logical_message_id) DO NOTHING`,
      [
        input.conversationId,
        input.direction,
        state,
        input.body ?? null,
        input.logicalMessageId,
        createdAt,
        now,
      ],
    );
    if (result.changes > 0) {
      await this.#db.run(
        "UPDATE conversations SET last_activity_at_ms = MAX(last_activity_at_ms, ?) WHERE id = ?",
        [createdAt, input.conversationId],
      );
    }
    const row = await this.#db.get("SELECT * FROM messages WHERE logical_message_id = ?", [
      input.logicalMessageId,
    ]);
    if (row === undefined) {
      throw new DatabaseError("adapter-error", "message insert did not produce a readable row");
    }
    return rowToMessage(row);
  }

  async getById(id: number): Promise<Message | undefined> {
    const row = await this.#db.get("SELECT * FROM messages WHERE id = ?", [id]);
    return row === undefined ? undefined : rowToMessage(row);
  }

  async getByLogicalId(logicalMessageId: string): Promise<Message | undefined> {
    const row = await this.#db.get("SELECT * FROM messages WHERE logical_message_id = ?", [
      logicalMessageId,
    ]);
    return row === undefined ? undefined : rowToMessage(row);
  }

  /**
   * Newest-first page of a conversation. `beforeId` is the keyset cursor:
   * pass the smallest id of the previous page to page backwards.
   */
  async listByConversation(
    conversationId: number,
    options: { beforeId?: number; limit?: number } = {},
  ): Promise<Message[]> {
    const limit = options.limit ?? 50;
    // Receipt-only acknowledgement rows (logical id `response:%`, ADR 0005) are
    // internal — never shown as chat bubbles.
    const rows =
      options.beforeId === undefined
        ? await this.#db.all(
            "SELECT * FROM messages WHERE conversation_id = ? AND logical_message_id NOT LIKE 'response:%' ORDER BY id DESC LIMIT ?",
            [conversationId, limit],
          )
        : await this.#db.all(
            "SELECT * FROM messages WHERE conversation_id = ? AND id < ? AND logical_message_id NOT LIKE 'response:%' ORDER BY id DESC LIMIT ?",
            [conversationId, options.beforeId, limit],
          );
    return rows.map(rowToMessage);
  }

  /** All messages in one of the given states (background workers, reconcile). */
  async listByState(states: readonly MessageState[], limit = 500): Promise<Message[]> {
    if (states.length === 0) {
      return [];
    }
    const placeholders = states.map(() => "?").join(", ");
    const rows = await this.#db.all(
      `SELECT * FROM messages WHERE state IN (${placeholders}) ORDER BY id LIMIT ?`,
      [...states, limit],
    );
    return rows.map(rowToMessage);
  }

  /** Count incoming messages not yet displayed (the shell's unread badge). */
  async countUnread(conversationId: number): Promise<number> {
    const row = await this.#db.get(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND direction = 'incoming' AND state = 'received'",
      [conversationId],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Move a message to a new state, enforcing the §11 state machine. A
   * transition to the current state is an idempotent no-op; anything the
   * state machine forbids throws "illegal-state-transition".
   */
  async transitionState(id: number, to: MessageState): Promise<Message> {
    return await this.#db.transaction(async () => {
      const current = await this.getById(id);
      if (current === undefined) {
        throw new DatabaseError("not-found", `message ${String(id)} does not exist`);
      }
      if (current.state === to) {
        return current; // idempotent re-application after a crash (§11)
      }
      if (!canTransitionMessage(current.direction, current.state, to)) {
        throw new DatabaseError(
          "illegal-state-transition",
          `${current.direction} message cannot transition ${current.state} → ${to}`,
        );
      }
      await this.#db.run("UPDATE messages SET state = ?, updated_at_ms = ? WHERE id = ?", [
        to,
        Date.now(),
        id,
      ]);
      const updated = await this.getById(id);
      if (updated === undefined) {
        throw new DatabaseError("adapter-error", "message vanished during state transition");
      }
      return updated;
    });
  }

  /** Record/replace the on-chain references for a message (send/receive flows). */
  async setChainRef(
    messageId: number,
    ref: {
      txHash?: string | null;
      outpointIndex?: number | null;
      replyToTxHash?: string | null;
      replyToOutpointIndex?: number | null;
    },
  ): Promise<void> {
    await this.#db.run(
      `INSERT INTO message_chain_refs (message_id, tx_hash, outpoint_index, reply_to_tx_hash, reply_to_outpoint_index)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         tx_hash = excluded.tx_hash,
         outpoint_index = excluded.outpoint_index,
         reply_to_tx_hash = excluded.reply_to_tx_hash,
         reply_to_outpoint_index = excluded.reply_to_outpoint_index`,
      [
        messageId,
        ref.txHash ?? null,
        ref.outpointIndex ?? null,
        ref.replyToTxHash ?? null,
        ref.replyToOutpointIndex ?? null,
      ],
    );
  }

  async getChainRef(messageId: number): Promise<MessageChainRef | undefined> {
    const row = await this.#db.get("SELECT * FROM message_chain_refs WHERE message_id = ?", [
      messageId,
    ]);
    if (row === undefined) {
      return undefined;
    }
    return {
      messageId: Number(row.message_id),
      txHash: row.tx_hash === null || row.tx_hash === undefined ? null : String(row.tx_hash),
      outpointIndex:
        row.outpoint_index === null || row.outpoint_index === undefined
          ? null
          : Number(row.outpoint_index),
      replyToTxHash:
        row.reply_to_tx_hash === null || row.reply_to_tx_hash === undefined
          ? null
          : String(row.reply_to_tx_hash),
      replyToOutpointIndex:
        row.reply_to_outpoint_index === null || row.reply_to_outpoint_index === undefined
          ? null
          : Number(row.reply_to_outpoint_index),
    };
  }

  /** Record a receipt for a message (ack flows; spec §10). */
  async addReceipt(input: {
    messageId: number;
    receiptType: number;
    txHash?: string;
    state: string;
  }): Promise<number> {
    const result = await this.#db.run(
      "INSERT INTO receipts (message_id, receipt_type, tx_hash, state, created_at_ms) VALUES (?, ?, ?, ?, ?)",
      [input.messageId, input.receiptType, input.txHash ?? null, input.state, Date.now()],
    );
    return result.lastInsertRowid;
  }

  /* ------------------------------------------- envelope id (Phase 8) -- */

  /**
   * Persist the envelope's 16-byte message id for an OUTGOING message
   * (schema v3). This is the key receipts and `reply_to_message_id` reference
   * — without it an incoming acknowledgement cannot be matched to the local
   * row (Phase 8 task 4).
   */
  async setEnvelopeMessageId(id: number, envelopeMessageIdHex: string): Promise<void> {
    const result = await this.#db.run(
      "UPDATE messages SET envelope_message_id_hex = ?, updated_at_ms = ? WHERE id = ?",
      [envelopeMessageIdHex, Date.now(), id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `message ${String(id)} does not exist`);
    }
  }

  /** Find a message by its envelope message id (receipt/reply matching). */
  async getByEnvelopeMessageId(envelopeMessageIdHex: string): Promise<Message | undefined> {
    const row = await this.#db.get("SELECT * FROM messages WHERE envelope_message_id_hex = ?", [
      envelopeMessageIdHex,
    ]);
    return row === undefined ? undefined : rowToMessage(row);
  }
}
