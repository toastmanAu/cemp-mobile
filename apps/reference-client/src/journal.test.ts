import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalAndSend, writeJournal } from "./journal.js";
import type { JournalEntry } from "./journal.js";
import type { Transaction } from "@cemp/ckb";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cemp-journal-test-"));
}

function sampleTx(): Transaction {
  return {
    version: "0x0",
    cellDeps: [],
    headerDeps: [],
    inputs: [
      {
        previousOutput: { txHash: `0x${"22".repeat(32)}`, index: "0x0" },
        since: "0x0",
      },
    ],
    outputs: [
      {
        capacity: "0x2540be400",
        lock: { codeHash: `0x${"33".repeat(32)}`, hashType: "type", args: "0x0102" },
        type: null,
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x10000000100000001000000010000000"],
  };
}

function sampleEntry(): JournalEntry {
  return {
    label: "send",
    createdAt: "2026-07-17T00:00:00.000Z",
    network: "ckb_testnet",
    unsignedTx: sampleTx(),
    resolvedInputs: [{ txHash: `0x${"22".repeat(32)}`, index: "0x0", capacity: "100000000000" }],
    estimatedFee: "1234",
    metadata: { messageId: "ab".repeat(16), routeTag: "cd".repeat(32) },
  };
}

describe("writeJournal", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists the unsigned tx, resolved inputs and metadata", () => {
    const file = writeJournal(dir, sampleEntry());
    const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as JournalEntry;
    expect(loaded.label).toBe("send");
    expect(loaded.unsignedTx).toEqual(sampleTx());
    expect(loaded.resolvedInputs[0]!.capacity).toBe("100000000000");
    expect(loaded.metadata.messageId).toBe("ab".repeat(16));
    // No plaintext message content anywhere in the journal (rule 3).
    expect(fs.readFileSync(file, "utf8")).not.toContain("hello bob");
  });

  it("rejects labels that are not file-safe", () => {
    expect(() => writeJournal(dir, { ...sampleEntry(), label: "../escape" })).toThrow(/file-safe/);
  });
});

describe("journalAndSend (rule 6: journal BEFORE broadcast)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the journal entry before send is invoked", async () => {
    const events: string[] = [];
    const entry = sampleEntry();
    const hash = await journalAndSend(dir, entry, () => {
      // The journal file must already exist and contain this exact entry.
      const file = path.join(dir, "send.json");
      events.push(fs.existsSync(file) ? "journal-present" : "journal-missing");
      const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as JournalEntry;
      events.push(loaded.unsignedTx.inputs[0]!.previousOutput.txHash);
      return Promise.resolve(`0x${"ab".repeat(32)}`);
    });
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(events).toEqual(["journal-present", `0x${"22".repeat(32)}`]);
  });

  it("leaves the journal on disk when the broadcast fails (resumable)", async () => {
    await expect(
      journalAndSend(dir, sampleEntry(), () => Promise.reject(new Error("node rejected"))),
    ).rejects.toThrow("node rejected");
    expect(fs.existsSync(path.join(dir, "send.json"))).toBe(true);
  });
});
