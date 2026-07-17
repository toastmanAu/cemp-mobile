/**
 * Attachment repository (spec Phase 6 task 5).
 *
 * Metadata + chunk bookkeeping only — attachment bytes never enter the
 * database (they live in the encrypted attachment directory, spec §3; chunk
 * cells land in Phase 10). The manifest is the encrypted CEMP attachment
 * manifest blob (spec §10).
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

  async create(input: {
    messageId: number;
    kind: string;
    byteLength: number;
    state?: string;
    manifest?: Uint8Array;
  }): Promise<Attachment> {
    const now = Date.now();
    const result = await this.#db.run(
      "INSERT INTO attachments (message_id, kind, byte_length, state, manifest, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [
        input.messageId,
        input.kind,
        input.byteLength,
        input.state ?? "pending",
        input.manifest ?? null,
        now,
      ],
    );
    return {
      id: result.lastInsertRowid,
      messageId: input.messageId,
      kind: input.kind,
      byteLength: input.byteLength,
      state: input.state ?? "pending",
      manifest: input.manifest ?? null,
      createdAtMs: now,
    };
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
