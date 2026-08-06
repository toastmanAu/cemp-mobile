import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, TABLE_NAMES } from "./schema.js";

describe("schema constants", () => {
  it("has unique table names", () => {
    expect(new Set(TABLE_NAMES).size).toBe(TABLE_NAMES.length);
  });

  it("tracks the current schema version (bump on every migration)", () => {
    // v9: attachments.remote_downloaded — the recipient's `0x05` receipt,
    // which gates chunk-cell reclaim so a lazily-downloaded image is not
    // destroyed on the envelope ack alone.
    expect(SCHEMA_VERSION).toBe(9);
  });

  it("covers the spec §11 core tables", () => {
    for (const required of [
      "contacts",
      "conversations",
      "messages",
      "message_chain_refs",
      "watched_outpoints",
      "reclaim_groups",
      "sync_cursors",
    ]) {
      expect(TABLE_NAMES).toContain(required);
    }
  });
});
