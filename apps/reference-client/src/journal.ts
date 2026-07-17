import fs from "node:fs";
import path from "node:path";
import type { BuiltTransaction, ResolvedInputDescription } from "@cemp/ckb";
import type { Transaction } from "@cemp/ckb";

/**
 * Pre-broadcast transaction journal (AGENTS.md rule 6): before ANY
 * `send_transaction` call, the unsigned transaction, its resolved inputs and
 * the builder metadata are persisted to `journal/<label>.json`. The journal
 * is what makes every background/broadcast operation auditable and resumable
 * (rule 5).
 *
 * Rule 3 note: journals carry the unsigned tx (whose outputs_data is the
 * ENCRYPTED envelope) plus public metadata (ids, tags, outpoints). Plaintext
 * message content is never written here.
 */
export interface JournalEntry {
  /** Broadcast label, e.g. "deploy-type", "profile.alice", "send". */
  label: string;
  createdAt: string;
  network: string;
  /** The UNSIGNED transaction (placeholder witnesses), types.ts JSON shape. */
  unsignedTx: Transaction;
  resolvedInputs: ResolvedInputDescription[];
  /** Shannons, decimal string. */
  estimatedFee: string;
  /** Builder metadata: message/conversation ids, tags, outpoints, capacities. */
  metadata: Record<string, unknown>;
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Write the journal entry atomically; returns the file path. */
export function writeJournal(journalDir: string, entry: JournalEntry): string {
  if (!LABEL_PATTERN.test(entry.label)) {
    throw new Error(`journal label ${JSON.stringify(entry.label)} is not file-safe`);
  }
  fs.mkdirSync(journalDir, { recursive: true });
  const file = path.join(journalDir, `${entry.label}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function journalEntryFromBuilt(
  label: string,
  network: string,
  built: BuiltTransaction,
  unsignedTx: Transaction,
  metadata: Record<string, unknown>,
): JournalEntry {
  return {
    label,
    createdAt: new Date().toISOString(),
    network,
    unsignedTx,
    resolvedInputs: built.resolvedInputsDescription,
    estimatedFee: built.estimatedFee.toString(),
    metadata,
  };
}

/**
 * The rule-6 ordering contract in one function: the journal write ALWAYS
 * happens before `send` is invoked. `send` is typically
 * `CempClient.sendTransaction` of the signed transaction.
 */
export async function journalAndSend(
  journalDir: string,
  entry: JournalEntry,
  send: () => Promise<string>,
): Promise<string> {
  writeJournal(journalDir, entry);
  return send();
}
