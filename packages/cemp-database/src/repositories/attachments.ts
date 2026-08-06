/**
 * Attachment repository (spec Phase 6 task 5).
 *
 * Metadata + chunk bookkeeping only — attachment BYTES never enter the
 * database (they live in the encrypted attachment directory, spec §3; chunk
 * cells land in Phase 10). The manifest is the encrypted CEMP attachment
 * manifest blob (spec §10).
 *
 * The one secret held here is `attachmentKey` (schema v8): the
 * envelope-derived 32-byte AES key for an INCOMING image, persisted at
 * discovery so tap-to-download survives the sender reclaiming the message
 * cell after ack (rule 9). Storing it is rule-3 compliant — this database is
 * encrypted and already holds the message plaintext. Outgoing keys are never
 * persisted (the send retry path re-encrypts, §9.2).
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export interface Attachment {
  readonly id: number;
  readonly messageId: number;
  readonly kind: string;
  readonly byteLength: number;
  readonly state: string;
  readonly manifest: Uint8Array | null;
  /**
   * The envelope-derived 32-byte attachment key for an incoming image
   * (schema v8; SECRET — lives only inside the encrypted database, rule 3).
   * Null for text messages, outgoing attachments, and pre-v8 rows.
   */
  readonly attachmentKey: Uint8Array | null;
  /**
   * OUTGOING attachments only (schema v9): the recipient has confirmed, with a
   * spec §8 `0x05 AttachmentDownloaded` receipt, that it fetched the bytes.
   *
   * This gates chunk-cell reclaim. A plain `0x01` receipt means only that the
   * message envelope was received — the recipient may not have tapped to
   * download yet — and reclaiming chunks on that basis destroyed the image
   * before it could ever be fetched (device-reported "tap to load" then
   * permanently "tap to retry").
   */
  readonly remoteDownloaded: boolean;
  readonly createdAtMs: number;
}

export interface AttachmentChunk {
  readonly id: number;
  readonly attachmentId: number;
  readonly chunkIndex: number;
  readonly outpointTxHash: string | null;
  readonly outpointIndex: number | null;
  readonly state: string;
}

function rowToAttachment(row: SqlRow): Attachment {
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    kind: String(row.kind),
    byteLength: Number(row.byte_length),
    state: String(row.state),
    manifest:
      row.manifest === null || row.manifest === undefined ? null : (row.manifest as Uint8Array),
    attachmentKey:
      row.attachment_key === null || row.attachment_key === undefined
        ? null
        : (row.attachment_key as Uint8Array),
    remoteDownloaded: Number(row.remote_downloaded ?? 0) !== 0,
    createdAtMs: Number(row.created_at_ms),
  };
}

function rowToChunk(row: SqlRow): AttachmentChunk {
  return {
    id: Number(row.id),
    attachmentId: Number(row.attachment_id),
    chunkIndex: Number(row.chunk_index),
    outpointTxHash:
      row.outpoint_tx_hash === null || row.outpoint_tx_hash === undefined
        ? null
        : String(row.outpoint_tx_hash),
    outpointIndex:
      row.outpoint_index === null || row.outpoint_index === undefined
        ? null
        : Number(row.outpoint_index),
    state: String(row.state),
  };
}

export class AttachmentRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  /**
   * Create the attachment row for a message. Idempotent per message (schema
   * v7 enforces one attachment per message, spec §3): re-creating for the
   * same message updates kind/size/manifest/attachment_key in place — the
   * state and the original creation time are preserved — and returns the
   * existing row. The attachment key REPLACEMENT is deliberate: a re-create
   * always carries the freshest derivation of the same message's key, so
   * refreshing it can never strand the download path on a stale key.
   */
  async create(input: {
    messageId: number;
    kind: string;
    byteLength: number;
    state?: string;
    manifest?: Uint8Array;
    /** 32-byte incoming attachment key (schema v8; secret, stored as BLOB). */
    attachmentKey?: Uint8Array;
  }): Promise<Attachment> {
    const now = Date.now();
    await this.#db.run(
      `INSERT INTO attachments (message_id, kind, byte_length, state, manifest, attachment_key, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         kind = excluded.kind,
         byte_length = excluded.byte_length,
         manifest = excluded.manifest,
         attachment_key = excluded.attachment_key`,
      [
        input.messageId,
        input.kind,
        input.byteLength,
        input.state ?? "pending",
        input.manifest ?? null,
        input.attachmentKey ?? null,
        now,
      ],
    );
    const row = await this.#db.get("SELECT * FROM attachments WHERE message_id = ?", [
      input.messageId,
    ]);
    if (row === undefined) {
      throw new DatabaseError("adapter-error", "attachment create did not produce a readable row");
    }
    return rowToAttachment(row);
  }

  async getById(id: number): Promise<Attachment | undefined> {
    const row = await this.#db.get("SELECT * FROM attachments WHERE id = ?", [id]);
    return row === undefined ? undefined : rowToAttachment(row);
  }

  async listForMessage(messageId: number): Promise<Attachment[]> {
    const rows = await this.#db.all("SELECT * FROM attachments WHERE message_id = ? ORDER BY id", [
      messageId,
    ]);
    return rows.map(rowToAttachment);
  }

  /** Batch lookup (chat screen reload): one query for many messages, no N+1. */
  async listForMessages(messageIds: readonly number[]): Promise<Attachment[]> {
    if (messageIds.length === 0) {
      return [];
    }
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = await this.#db.all(
      `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY message_id, id`,
      [...messageIds],
    );
    return rows.map(rowToAttachment);
  }

  /**
   * Record that the recipient confirmed downloading this message's attachment
   * (spec §8 `0x05`). Idempotent — a repeated receipt is a no-op — and a
   * no-op for messages with no attachment row.
   */
  async markRemoteDownloaded(messageId: number): Promise<void> {
    await this.#db.run("UPDATE attachments SET remote_downloaded = 1 WHERE message_id = ?", [
      messageId,
    ]);
  }

  /** Idempotent per (attachment, chunk_index): re-registering updates in place. */
  async registerChunk(input: {
    attachmentId: number;
    chunkIndex: number;
    outpointTxHash?: string;
    outpointIndex?: number;
    state: string;
  }): Promise<AttachmentChunk> {
    await this.#db.run(
      `INSERT INTO attachment_chunks (attachment_id, chunk_index, outpoint_tx_hash, outpoint_index, state)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (attachment_id, chunk_index) DO UPDATE SET
         outpoint_tx_hash = excluded.outpoint_tx_hash,
         outpoint_index = excluded.outpoint_index,
         state = excluded.state`,
      [
        input.attachmentId,
        input.chunkIndex,
        input.outpointTxHash ?? null,
        input.outpointIndex ?? null,
        input.state,
      ],
    );
    const row = await this.#db.get(
      "SELECT * FROM attachment_chunks WHERE attachment_id = ? AND chunk_index = ?",
      [input.attachmentId, input.chunkIndex],
    );
    if (row === undefined) {
      throw new DatabaseError("adapter-error", "chunk register did not produce a readable row");
    }
    return rowToChunk(row);
  }

  async listChunks(attachmentId: number): Promise<AttachmentChunk[]> {
    const rows = await this.#db.all(
      "SELECT * FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index",
      [attachmentId],
    );
    return rows.map(rowToChunk);
  }

  async setChunkState(attachmentId: number, chunkIndex: number, state: string): Promise<void> {
    const result = await this.#db.run(
      "UPDATE attachment_chunks SET state = ? WHERE attachment_id = ? AND chunk_index = ?",
      [state, attachmentId, chunkIndex],
    );
    if (result.changes === 0) {
      throw new DatabaseError(
        "not-found",
        `chunk ${String(chunkIndex)} of attachment ${String(attachmentId)} does not exist`,
      );
    }
  }
}
