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
import { blobToBytes } from "../blob.js";
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
  /**
   * Sender authentication of an INCOMING row (schema v11, ADR 0007): null for
   * outgoing and pre-upgrade rows. The UI labels `legacy-unverified` rows
   * "Unverified (legacy)" and shows a blocking card for
   * `key-changed-blocking` rows (whose body is never stored).
   */
  readonly authStatus: MessageAuthStatus | null;
  /** ckbHash of the key that verified this incoming v3 message, hex. */
  readonly senderKeyHashHex: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export const MESSAGE_AUTH_STATUSES = [
  "verified",
  "legacy-unverified",
  "key-changed-blocking",
] as const;
export type MessageAuthStatus = (typeof MESSAGE_AUTH_STATUSES)[number];

/** A signed outgoing envelope journaled before broadcast (schema v11). */
export interface PreparedEnvelope {
  readonly envelopeBytes: Uint8Array;
  readonly routeTag: Uint8Array;
  readonly conversationTag: Uint8Array;
  readonly messageNonce: Uint8Array;
  readonly messageId: Uint8Array;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: unknown, label: string): Uint8Array {
  const text = typeof value === "string" ? value : "";
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new DatabaseError("adapter-error", `prepared envelope field ${label} is not hex`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
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
    authStatus: nullableText(row.auth_status) as MessageAuthStatus | null,
    senderKeyHashHex: nullableText(row.sender_key_hash_hex),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

/** A driver-agnostic copy of a stored 32-byte receipt key; anything else is null. */
function receiptKeyCopy(value: unknown): Uint8Array | null {
  const bytes = blobToBytes(value);
  return bytes === null || bytes.length !== 32 ? null : bytes.slice();
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

  /* ------------------------------ sender authentication (schema v11) -- */

  /** Record how an incoming row's sender was authenticated (ADR 0007 §5, §8). */
  async setSenderAuthentication(
    id: number,
    auth: { authStatus: MessageAuthStatus; senderKeyHashHex: string | null },
  ): Promise<void> {
    if (!(MESSAGE_AUTH_STATUSES as readonly string[]).includes(auth.authStatus)) {
      throw new DatabaseError(
        "constraint-violation",
        `unknown auth status ${String(auth.authStatus)}`,
      );
    }
    if (auth.senderKeyHashHex !== null && !/^[0-9a-f]{64}$/.test(auth.senderKeyHashHex)) {
      throw new DatabaseError(
        "constraint-violation",
        "sender key hash must be 32-byte lowercase hex",
      );
    }
    const result = await this.#db.run(
      "UPDATE messages SET auth_status = ?, sender_key_hash_hex = ?, updated_at_ms = ? WHERE id = ?",
      [auth.authStatus, auth.senderKeyHashHex, Date.now(), id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `message ${String(id)} does not exist`);
    }
  }

  /**
   * Journal the signed outgoing envelope (ADR 0007 §7) so a crash or retry
   * rebroadcasts identical bytes instead of producing a second signature.
   */
  async setPreparedEnvelope(id: number, prepared: PreparedEnvelope): Promise<void> {
    const json = JSON.stringify({
      envelope: toHex(prepared.envelopeBytes),
      routeTag: toHex(prepared.routeTag),
      conversationTag: toHex(prepared.conversationTag),
      messageNonce: toHex(prepared.messageNonce),
      messageId: toHex(prepared.messageId),
    });
    const result = await this.#db.run(
      "UPDATE messages SET prepared_envelope = ?, updated_at_ms = ? WHERE id = ?",
      [json, Date.now(), id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `message ${String(id)} does not exist`);
    }
  }

  async getPreparedEnvelope(id: number): Promise<PreparedEnvelope | undefined> {
    const row = await this.#db.get("SELECT prepared_envelope FROM messages WHERE id = ?", [id]);
    const text = row?.prepared_envelope;
    if (text === null || text === undefined) {
      return undefined;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(text)) as Record<string, unknown>;
    } catch (e) {
      throw new DatabaseError("adapter-error", "prepared envelope is not valid JSON", e);
    }
    return {
      envelopeBytes: fromHex(parsed.envelope, "envelope"),
      routeTag: fromHex(parsed.routeTag, "routeTag"),
      conversationTag: fromHex(parsed.conversationTag, "conversationTag"),
      messageNonce: fromHex(parsed.messageNonce, "messageNonce"),
      messageId: fromHex(parsed.messageId, "messageId"),
    };
  }

  /* ---------------------------------------- receipt key (schema v10) -- */

  /**
   * Persist the message's ADR 0006 receipt key. SECRET: kept only in the
   * encrypted database (rule 3), deliberately absent from {@link Message} so
   * ordinary reads never carry it.
   */
  async setReceiptKey(id: number, receiptKey: Uint8Array): Promise<void> {
    if (receiptKey.length !== 32) {
      throw new DatabaseError(
        "constraint-violation",
        `receipt key is ${String(receiptKey.length)} bytes, expected 32`,
      );
    }
    const result = await this.#db.run(
      "UPDATE messages SET receipt_key = ?, updated_at_ms = ? WHERE id = ?",
      [receiptKey.slice(), Date.now(), id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `message ${String(id)} does not exist`);
    }
  }

  /** The stored receipt key (a fresh copy the caller wipes), or null. */
  async getReceiptKey(id: number): Promise<Uint8Array | null> {
    const row = await this.#db.get("SELECT receipt_key FROM messages WHERE id = ?", [id]);
    return receiptKeyCopy(row?.receipt_key);
  }

  /**
   * An OUTGOING message by envelope id, with the profile id of the contact its
   * conversation is with — the party allowed to acknowledge it — and the
   * receipt key that verifies the proof (null for pre-ADR-0006 rows).
   */
  async getOutgoingWithRecipientByEnvelopeMessageId(envelopeMessageIdHex: string): Promise<
    | {
        message: Message;
        recipientProfileIdHex: string | null;
        receiptKey: Uint8Array | null;
      }
    | undefined
  > {
    const row = await this.#db.get(
      `SELECT m.*, ct.profile_id_hex AS recipient_profile_id_hex
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
        WHERE m.envelope_message_id_hex = ? AND m.direction = 'outgoing'`,
      [envelopeMessageIdHex],
    );
    if (row === undefined) {
      return undefined;
    }
    const recipient = row.recipient_profile_id_hex;
    return {
      message: rowToMessage(row),
      recipientProfileIdHex:
        recipient === null || recipient === undefined ? null : String(recipient),
      receiptKey: receiptKeyCopy(row.receipt_key),
    };
  }

  /** Find a message by its envelope message id (receipt/reply matching). */
  async getByEnvelopeMessageId(envelopeMessageIdHex: string): Promise<Message | undefined> {
    const row = await this.#db.get("SELECT * FROM messages WHERE envelope_message_id_hex = ?", [
      envelopeMessageIdHex,
    ]);
    return row === undefined ? undefined : rowToMessage(row);
  }
}
