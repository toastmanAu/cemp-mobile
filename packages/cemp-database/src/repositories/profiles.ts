/**
 * Own-profile repository (spec §5.3, Phase 5 task 7).
 *
 * Tracks the user's own profile cells and their rotation lineage: each
 * rotation writes a NEW profile row (new Type ID) whose
 * `previous_profile_id_hex` names the retired one, and the retired row is
 * marked `rotated` — never deleted (rule 8: local history survives on-chain
 * changes). {@link getLineage} walks the back-references to the chain root,
 * which is what the contact-trust flow checks on the other side.
 */

import type { SqliteAdapter, SqlRow } from "../adapter.js";
import { DatabaseError } from "../errors.js";

export type ProfileState = "active" | "rotated" | "revoked";

export interface StoredProfile {
  readonly id: number;
  readonly accountId: number;
  readonly profileIdHex: string;
  readonly typeIdHex: string | null;
  readonly outpointTxHash: string | null;
  readonly outpointIndex: number | null;
  readonly state: ProfileState;
  readonly previousProfileIdHex: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

function rowToProfile(row: SqlRow): StoredProfile {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    profileIdHex: String(row.profile_id_hex),
    typeIdHex:
      row.type_id_hex === null || row.type_id_hex === undefined ? null : String(row.type_id_hex),
    outpointTxHash:
      row.outpoint_tx_hash === null || row.outpoint_tx_hash === undefined
        ? null
        : String(row.outpoint_tx_hash),
    outpointIndex:
      row.outpoint_index === null || row.outpoint_index === undefined
        ? null
        : Number(row.outpoint_index),
    state: String(row.state) as ProfileState,
    previousProfileIdHex:
      row.previous_profile_id_hex === null || row.previous_profile_id_hex === undefined
        ? null
        : String(row.previous_profile_id_hex),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class ProfileRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async create(input: {
    accountId: number;
    profileIdHex: string;
    typeIdHex?: string | undefined;
    outpointTxHash?: string | undefined;
    outpointIndex?: number | undefined;
    previousProfileIdHex?: string | undefined;
    state?: ProfileState | undefined;
  }): Promise<StoredProfile> {
    const now = Date.now();
    try {
      const result = await this.#db.run(
        `INSERT INTO profiles
           (account_id, profile_id_hex, type_id_hex, outpoint_tx_hash, outpoint_index,
            state, previous_profile_id_hex, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.accountId,
          input.profileIdHex,
          input.typeIdHex ?? null,
          input.outpointTxHash ?? null,
          input.outpointIndex ?? null,
          input.state ?? "active",
          input.previousProfileIdHex ?? null,
          now,
          now,
        ],
      );
      return {
        id: result.lastInsertRowid,
        accountId: input.accountId,
        profileIdHex: input.profileIdHex,
        typeIdHex: input.typeIdHex ?? null,
        outpointTxHash: input.outpointTxHash ?? null,
        outpointIndex: input.outpointIndex ?? null,
        state: input.state ?? "active",
        previousProfileIdHex: input.previousProfileIdHex ?? null,
        createdAtMs: now,
        updatedAtMs: now,
      };
    } catch (e) {
      throw new DatabaseError(
        "constraint-violation",
        "profile insert failed (profile id already used?)",
        e,
      );
    }
  }

  async getByProfileId(profileIdHex: string): Promise<StoredProfile | undefined> {
    const row = await this.#db.get("SELECT * FROM profiles WHERE profile_id_hex = ?", [
      profileIdHex,
    ]);
    return row === undefined ? undefined : rowToProfile(row);
  }

  /** The account's current active profile, if any. */
  async getActiveByAccount(accountId: number): Promise<StoredProfile | undefined> {
    const row = await this.#db.get(
      "SELECT * FROM profiles WHERE account_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1",
      [accountId],
    );
    return row === undefined ? undefined : rowToProfile(row);
  }

  /**
   * Record a rotation: the old profile is marked `rotated` and the successor
   * row is inserted with its back-reference — atomically (both or neither).
   */
  async rotate(
    oldProfileIdHex: string,
    successor: {
      profileIdHex: string;
      typeIdHex?: string;
      outpointTxHash?: string;
      outpointIndex?: number;
    },
  ): Promise<StoredProfile> {
    return await this.#db.transaction(async () => {
      const old = await this.getByProfileId(oldProfileIdHex);
      if (old === undefined) {
        throw new DatabaseError("not-found", `profile ${oldProfileIdHex} does not exist`);
      }
      if (old.state !== "active") {
        throw new DatabaseError(
          "illegal-state-transition",
          `profile ${oldProfileIdHex} is ${old.state}, only an active profile rotates`,
        );
      }
      await this.#db.run("UPDATE profiles SET state = 'rotated', updated_at_ms = ? WHERE id = ?", [
        Date.now(),
        old.id,
      ]);
      return await this.create({
        accountId: old.accountId,
        profileIdHex: successor.profileIdHex,
        typeIdHex: successor.typeIdHex,
        outpointTxHash: successor.outpointTxHash,
        outpointIndex: successor.outpointIndex,
        previousProfileIdHex: old.profileIdHex,
      });
    });
  }

  async markRevoked(profileIdHex: string): Promise<void> {
    const result = await this.#db.run(
      "UPDATE profiles SET state = 'revoked', updated_at_ms = ? WHERE profile_id_hex = ?",
      [Date.now(), profileIdHex],
    );
    if (result.changes === 0) {
      throw new DatabaseError("not-found", `profile ${profileIdHex} does not exist`);
    }
  }

  /**
   * The rotation lineage ending at `profileIdHex`, oldest first (chain root
   * → tip) — the shape {@link validateRotationChain} consumes. Cycles are
   * defended against (a corrupted row can't loop the walk forever).
   */
  async getLineage(profileIdHex: string): Promise<StoredProfile[]> {
    const lineage: StoredProfile[] = [];
    const seen = new Set<string>();
    let cursor: string | null = profileIdHex;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new DatabaseError("constraint-violation", "profile lineage contains a cycle");
      }
      seen.add(cursor);
      const profile: StoredProfile | undefined = await this.getByProfileId(cursor);
      if (profile === undefined) {
        throw new DatabaseError("not-found", `lineage references unknown profile ${cursor}`);
      }
      lineage.unshift(profile);
      cursor = profile.previousProfileIdHex;
    }
    return lineage;
  }
}
