/**
 * Error type for @cemp/database.
 *
 * Every failure surfaces as {@link DatabaseError} with a machine-readable
 * `code` (same pattern as @cemp/secure-vault's VaultError). AGENTS.md rule 2:
 * messages carry column/state names, never row contents (message bodies,
 * contact notes) or key material.
 */

export const DATABASE_ERROR_CODE = {
  /** A row the caller addressed by id/key does not exist. */
  NotFound: "not-found",
  /** A §11 message-state transition that the state machine forbids. */
  IllegalStateTransition: "illegal-state-transition",
  /** Migration bookkeeping is inconsistent (unknown version, gap). */
  MigrationError: "migration-error",
  /** A SQLite constraint rejected the write (forwarded, message is structural). */
  ConstraintViolation: "constraint-violation",
  /** The adapter/connection itself failed. */
  AdapterError: "adapter-error",
} as const;
export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODE)[keyof typeof DATABASE_ERROR_CODE];

/** All failures of @cemp/database are reported as this type. */
export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseError";
    this.code = code;
  }
}
