import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, TABLE_NAMES } from "./schema.js";

describe("schema constants", () => {
  it("has unique table names", () => {
    expect(new Set(TABLE_NAMES).size).toBe(TABLE_NAMES.length);
  });

  it("tracks the current schema version (bump on every migration)", () => {
    // v3: response/reclaim lifecycle (Phase 8 envelope ids + reclaim capacity).
    expect(SCHEMA_VERSION).toBe(3);
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
