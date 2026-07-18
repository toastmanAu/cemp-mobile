/**
 * Contact repository (spec Phase 6 task 2).
 *
 * Display names, notes and avatar bytes live ONLY here, inside the encrypted
 * database (Phase 6 exit criterion: "Contact avatars and notes remain local
 * and encrypted") — nothing in this repository touches any network or chain
 * field beyond the contact's public profile id.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export interface Contact {
  readonly id: number;
  readonly displayName: string;
  readonly notes: string;
  readonly profileIdHex: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ContactWithAvatar extends Contact {
  readonly avatar: Uint8Array | null;
}

export interface ContactPatch {
  readonly displayName?: string;
  readonly notes?: string;
  readonly profileIdHex?: string | null;
}

function rowToContact(row: SqlRow, includeAvatar: false): Contact;
function rowToContact(row: SqlRow, includeAvatar: true): ContactWithAvatar;
function rowToContact(row: SqlRow, includeAvatar: boolean): Contact | ContactWithAvatar {
  const base: Contact = {
    id: Number(row.id),
    displayName: String(row.display_name),
    notes: String(row.notes),
    profileIdHex:
      row.profile_id_hex === null || row.profile_id_hex === undefined
        ? null
        : String(row.profile_id_hex),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
  if (!includeAvatar) {
    return base;
  }
  const avatar = row.avatar;
  const result: ContactWithAvatar = {
    ...base,
    avatar: avatar === null || avatar === undefined ? null : (avatar as Uint8Array),
  };
  return result;
}

export class ContactRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async create(input: {
    displayName: string;
    notes?: string;
    avatar?: Uint8Array;
    profileIdHex?: string;
  }): Promise<Contact> {
    const now = Date.now();
    try {
      const result = await this.#db.run(
        `INSERT INTO contacts (display_name, notes, avatar, profile_id_hex, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.displayName,
          input.notes ?? "",
          input.avatar ?? null,
          input.profileIdHex ?? null,
          now,
          now,
        ],
      );
      return {
        id: result.lastInsertRowid,
        displayName: input.displayName,
        notes: input.notes ?? "",
        profileIdHex: input.profileIdHex ?? null,
        createdAtMs: now,
        updatedAtMs: now,
      };
    } catch (e) {
      throw new DatabaseError(
        "constraint-violation",
        "contact insert failed (profile id already used?)",
        e,
      );
    }
  }

  async getById(id: number): Promise<Contact | undefined> {
    const row = await this.#db.get(
      "SELECT id, display_name, notes, profile_id_hex, created_at_ms, updated_at_ms FROM contacts WHERE id = ?",
      [id],
    );
    return row === undefined ? undefined : rowToContact(row, false);
  }

  async getByIdWithAvatar(id: number): Promise<ContactWithAvatar | undefined> {
    const row = await this.#db.get("SELECT * FROM contacts WHERE id = ?", [id]);
    return row === undefined ? undefined : rowToContact(row, true);
  }

  async getByProfileId(profileIdHex: string): Promise<Contact | undefined> {
    const row = await this.#db.get(
      "SELECT id, display_name, notes, profile_id_hex, created_at_ms, updated_at_ms FROM contacts WHERE profile_id_hex = ?",
      [profileIdHex],
    );
    return row === undefined ? undefined : rowToContact(row, false);
  }

  /** Case-insensitive substring search over display names, ordered by name. */
  async search(query: string): Promise<Contact[]> {
    const rows = await this.#db.all(
      `SELECT id, display_name, notes, profile_id_hex, created_at_ms, updated_at_ms
       FROM contacts WHERE display_name LIKE ? ESCAPE '\\' ORDER BY display_name COLLATE NOCASE`,
      [`%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
    );
    return rows.map((r) => rowToContact(r, false));
  }

  /** All contacts, ordered by display name. Avatars excluded (use getByIdWithAvatar). */
  async list(): Promise<Contact[]> {
    const rows = await this.#db.all(
      "SELECT id, display_name, notes, profile_id_hex, created_at_ms, updated_at_ms FROM contacts ORDER BY display_name COLLATE NOCASE",
    );
    return rows.map((r) => rowToContact(r, false));
  }

  async update(id: number, patch: ContactPatch): Promise<Contact> {
    const existing = await this.getById(id);
    if (existing === undefined) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
    const displayName = patch.displayName ?? existing.displayName;
    const notes = patch.notes ?? existing.notes;
    const profileIdHex =
      patch.profileIdHex === undefined ? existing.profileIdHex : patch.profileIdHex;
    const now = Date.now();
    try {
      await this.#db.run(
        "UPDATE contacts SET display_name = ?, notes = ?, profile_id_hex = ?, updated_at_ms = ? WHERE id = ?",
        [displayName, notes, profileIdHex, now, id],
      );
    } catch (e) {
      throw new DatabaseError(
        "constraint-violation",
        "contact update failed (profile id already used?)",
        e,
      );
    }
    return { ...existing, displayName, notes, profileIdHex, updatedAtMs: now };
  }

  async setAvatar(id: number, avatar: Uint8Array | null): Promise<void> {
    const result = await this.#db.run(
      "UPDATE contacts SET avatar = ?, updated_at_ms = ? WHERE id = ?",
      [avatar, Date.now(), id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
  }

  async remove(id: number): Promise<void> {
    const result = await this.#db.run("DELETE FROM contacts WHERE id = ?", [id]);
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
  }

  /* --------------------------------------------- block controls (v5) -- */

  /**
   * Block or unblock a contact (spec Phase 11 task 10). Blocked senders are
   * dropped at ingestion by the discovery worker; the app refuses to send to
   * a blocked contact. History is preserved either way (rule 8 — blocking is
   * a processing gate, not a deletion).
   */
  async setBlocked(id: number, blocked: boolean): Promise<void> {
    const result = await this.#db.run(
      "UPDATE contacts SET blocked = ?, updated_at_ms = ? WHERE id = ?",
      [blocked ? 1 : 0, Date.now(), id],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
  }

  async isBlocked(id: number): Promise<boolean> {
    const row = await this.#db.get("SELECT blocked FROM contacts WHERE id = ?", [id]);
    if (row === undefined) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
    return Number(row.blocked) === 1;
  }

  /** Whether the contact linked to this profile id is blocked (false when unknown). */
  async isBlockedByProfileId(profileIdHex: string): Promise<boolean> {
    const row = await this.#db.get("SELECT blocked FROM contacts WHERE profile_id_hex = ?", [
      profileIdHex,
    ]);
    return row !== undefined && Number(row.blocked) === 1;
  }

  /**
   * Report a contact (task 10): records the event in `security_events`. The
   * report is a local trust annotation — it never leaves the device.
   */
  async report(id: number, reason: string): Promise<void> {
    const exists = await this.getById(id);
    if (exists === undefined) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
    await this.#db.run(
      "INSERT INTO security_events (kind, detail, created_at_ms) VALUES (?, ?, ?)",
      ["contact_reported", reason.slice(0, 256), Date.now()],
    );
  }

  /* --------------------------------------- profile trust material (v2) -- */

  /**
   * Store the contact's verified on-chain profile material (Phase 5): the
   * profile's Type ID, public keys and computed fingerprint, plus the latest
   * trust verdict from `evaluateContactProfile`. These bytes are PUBLIC (the
   * profile cell publishes them); they are stored locally so unexpected key
   * changes are detectable offline.
   */
  async setProfileSecurity(
    id: number,
    security: {
      profileTypeIdHex: string;
      mlDsaPublicKey: Uint8Array;
      mlKemPublicKey: Uint8Array;
      fingerprint: string;
      trustVerdict: string;
    },
  ): Promise<void> {
    const result = await this.#db.run(
      `UPDATE contacts SET profile_type_id_hex = ?, ml_dsa_public_key = ?, ml_kem_public_key = ?,
         fingerprint = ?, trust_verdict = ?, updated_at_ms = ?
       WHERE id = ?`,
      [
        security.profileTypeIdHex,
        security.mlDsaPublicKey,
        security.mlKemPublicKey,
        security.fingerprint,
        security.trustVerdict,
        Date.now(),
        id,
      ],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `contact ${String(id)} does not exist`);
    }
  }

  /** The stored profile-trust material, or undefined when the contact is gone. */
  async getProfileSecurity(id: number): Promise<ContactProfileSecurity | undefined> {
    const row = await this.#db.get(
      "SELECT profile_type_id_hex, ml_dsa_public_key, ml_kem_public_key, fingerprint, trust_verdict FROM contacts WHERE id = ?",
      [id],
    );
    if (row === undefined) {
      return undefined;
    }
    const blob = (v: unknown): Uint8Array | null =>
      v === null || v === undefined ? null : (v as Uint8Array);
    const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return {
      profileTypeIdHex: text(row.profile_type_id_hex),
      mlDsaPublicKey: blob(row.ml_dsa_public_key),
      mlKemPublicKey: blob(row.ml_kem_public_key),
      fingerprint: text(row.fingerprint),
      trustVerdict: text(row.trust_verdict),
    };
  }
}

/** A contact's stored profile-trust material (schema v2). */
export interface ContactProfileSecurity {
  readonly profileTypeIdHex: string | null;
  readonly mlDsaPublicKey: Uint8Array | null;
  readonly mlKemPublicKey: Uint8Array | null;
  readonly fingerprint: string | null;
  readonly trustVerdict: string | null;
}
