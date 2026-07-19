/**
 * Conversation repository (spec Phase 6 task 3).
 *
 * One conversation per contact (schema UNIQUE). The list query the messenger
 * shell consumes — conversations ordered by last activity with a last-message
 * preview and an unread count — is a SINGLE SQL statement, not an N+1 loop.
 * "Unread" = incoming messages in state `received` (not yet `displayed`).
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export interface Conversation {
  readonly id: number;
  readonly contactId: number;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
}

export interface ConversationListItem extends Conversation {
  readonly contactDisplayName: string;
  readonly lastMessageBody: string | null;
  readonly lastMessageState: string | null;
  readonly lastMessageDirection: string | null;
  readonly unreadCount: number;
}

function rowToConversation(row: SqlRow): Conversation {
  return {
    id: Number(row.id),
    contactId: Number(row.contact_id),
    createdAtMs: Number(row.created_at_ms),
    lastActivityAtMs: Number(row.last_activity_at_ms),
  };
}

export class ConversationRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /** Idempotent: returns the existing conversation when one exists (rule 5). */
  async getOrCreateForContact(contactId: number): Promise<Conversation> {
    const existing = await this.getByContact(contactId);
    if (existing !== undefined) {
      return existing;
    }
    const now = Date.now();
    try {
      const result = await this.#db.run(
        "INSERT INTO conversations (contact_id, created_at_ms, last_activity_at_ms) VALUES (?, ?, ?)",
        [contactId, now, now],
      );
      return { id: result.lastInsertRowid, contactId, createdAtMs: now, lastActivityAtMs: now };
    } catch (e) {
      // Lost a race with a concurrent insert — re-read (the UNIQUE constraint
      // on contact_id makes this safe), or the contact id is invalid.
      const raced = await this.getByContact(contactId);
      if (raced !== undefined) {
        return raced;
      }
      throw new DatabaseError(
        "constraint-violation",
        `cannot create conversation for contact ${String(contactId)}`,
        e,
      );
    }
  }

  async getById(id: number): Promise<Conversation | undefined> {
    const row = await this.#db.get(
      "SELECT id, contact_id, created_at_ms, last_activity_at_ms FROM conversations WHERE id = ?",
      [id],
    );
    return row === undefined ? undefined : rowToConversation(row);
  }

  async getByContact(contactId: number): Promise<Conversation | undefined> {
    const row = await this.#db.get(
      "SELECT id, contact_id, created_at_ms, last_activity_at_ms FROM conversations WHERE contact_id = ?",
      [contactId],
    );
    return row === undefined ? undefined : rowToConversation(row);
  }

  /** Bump the activity timestamp (called by the message repository on insert). */
  async touch(id: number, atMs: number): Promise<void> {
    const result = await this.#db.run(
      "UPDATE conversations SET last_activity_at_ms = MAX(last_activity_at_ms, ?) WHERE id = ?",
      [atMs, id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `conversation ${String(id)} does not exist`);
    }
  }

  /**
   * The shell's conversation list: one query (correlated subqueries for the
   * preview and unread count), newest activity first.
   */
  async listWithPreview(): Promise<ConversationListItem[]> {
    const rows = await this.#db.all(
      `SELECT c.id, c.contact_id, c.created_at_ms, c.last_activity_at_ms,
              ct.display_name AS contact_display_name,
              (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.logical_message_id NOT LIKE 'response:%' ORDER BY m.id DESC LIMIT 1) AS last_message_body,
              (SELECT m.state FROM messages m WHERE m.conversation_id = c.id AND m.logical_message_id NOT LIKE 'response:%' ORDER BY m.id DESC LIMIT 1) AS last_message_state,
              (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id AND m.logical_message_id NOT LIKE 'response:%' ORDER BY m.id DESC LIMIT 1) AS last_message_direction,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'incoming' AND m.state = 'received') AS unread_count
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       ORDER BY c.last_activity_at_ms DESC`,
    );
    return rows.map((row) => ({
      ...rowToConversation(row),
      contactDisplayName: String(row.contact_display_name),
      lastMessageBody:
        row.last_message_body === null || row.last_message_body === undefined
          ? null
          : String(row.last_message_body),
      lastMessageState:
        row.last_message_state === null || row.last_message_state === undefined
          ? null
          : String(row.last_message_state),
      lastMessageDirection:
        row.last_message_direction === null || row.last_message_direction === undefined
          ? null
          : String(row.last_message_direction),
      unreadCount: Number(row.unread_count),
    }));
  }
}
