import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "../node.js";
import { migrate } from "../migrate.js";
import { LocalSettingsRepository, MY_DISPLAY_NAME_KEY } from "./local-settings.js";

describe("LocalSettingsRepository", () => {
  let db: NodeSqliteAdapter;
  let repo: LocalSettingsRepository;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    repo = new LocalSettingsRepository(db);
  });

  it("returns null for a key that was never set", async () => {
    expect(await repo.get(MY_DISPLAY_NAME_KEY)).toBeNull();
  });

  it("stores and reads back a value", async () => {
    await repo.set(MY_DISPLAY_NAME_KEY, "Phill");
    expect(await repo.get(MY_DISPLAY_NAME_KEY)).toBe("Phill");
  });

  it("overwrites rather than duplicating on a second set", async () => {
    await repo.set(MY_DISPLAY_NAME_KEY, "Phill");
    await repo.set(MY_DISPLAY_NAME_KEY, "Phillip");
    expect(await repo.get(MY_DISPLAY_NAME_KEY)).toBe("Phillip");
    const rows = await db.all("SELECT key FROM local_settings");
    expect(rows).toHaveLength(1);
  });

  it("keeps distinct keys independent", async () => {
    await repo.set("a", "1");
    await repo.set("b", "2");
    expect(await repo.get("a")).toBe("1");
    expect(await repo.get("b")).toBe("2");
  });

  it("round-trips unicode and empty values", async () => {
    await repo.set("emoji", "Phill 🛰️");
    await repo.set("empty", "");
    expect(await repo.get("emoji")).toBe("Phill 🛰️");
    expect(await repo.get("empty")).toBe("");
  });
});
