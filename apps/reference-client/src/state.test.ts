import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore, defaultIdentityState, defaultSharedState, runCheckpointed } from "./state.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cemp-state-test-"));
}

describe("StateStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips shared and identity state through JSON files", () => {
    const store = new StateStore(dir);
    const shared = defaultSharedState();
    shared.deployment = {
      network: "ckb_testnet",
      contract: "cemp-message-type",
      version: "0.1.0",
      deployTxHash: "0xabcd",
      outPointIndex: 0,
      codeHash: "0x1234",
      hashType: "data1",
      deployedAt: "2026-07-17",
      sourceCommit: "deadbeef",
      notes: "test",
    };
    store.saveShared(shared);

    const identity = defaultIdentityState("alice", {
      handle: "alice-ref",
      address: "ckt1q...",
      lockArgs: "0x0102",
      lockScriptHash: "0x0304",
      deviceId: "aabb",
    });
    identity.fees.send = "1234";
    identity.messages.push({
      messageId: "ff".repeat(16),
      direction: "sent",
      peerProfileId: "ee".repeat(32),
      txHash: "0x99",
      outPoint: { txHash: "0x99", index: "0x0" },
      status: "published",
      recordedAt: "2026-07-17T00:00:00.000Z",
    });
    store.saveIdentity(identity);

    const loadedShared = store.loadShared();
    expect(loadedShared.deployment?.deployTxHash).toBe("0xabcd");
    const loadedIdentity = store.loadIdentity("alice");
    expect(loadedIdentity.fees.send).toBe("1234");
    // Local history survives reloads (rule 8).
    expect(loadedIdentity.messages.length).toBe(1);
    expect(loadedIdentity.messages[0]!.status).toBe("published");
  });

  it("rejects a state file with the wrong identity", () => {
    const store = new StateStore(dir);
    const identity = defaultIdentityState("bob", {
      handle: "bob-ref",
      address: "ckt1q...",
      lockArgs: "0x",
      lockScriptHash: "0x",
      deviceId: "00",
    });
    store.saveIdentity(identity);
    // Sneak bob's content into alice's file: loading must refuse, not guess.
    fs.copyFileSync(store.identityPath("bob"), store.identityPath("alice"));
    expect(() => store.loadIdentity("alice")).toThrow(/mismatch/);
  });
});

describe("runCheckpointed (rule 5: resume skips completed steps)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs a step once, then skips it on resume", async () => {
    const store = new StateStore(dir);
    const shared = defaultSharedState();
    let runs = 0;

    const first = await runCheckpointed(store, shared, "profiles", async () => {
      runs += 1;
      return "done";
    });
    expect(first).toEqual({ ran: true, result: "done" });
    expect(shared.steps.profiles).toBe(true);

    // Simulate a process restart: reload shared state from disk.
    const reloaded = store.loadShared();
    const second = await runCheckpointed(store, reloaded, "profiles", async () => {
      runs += 1;
      return "done";
    });
    expect(second.ran).toBe(false);
    expect(runs).toBe(1);
  });

  it("does not checkpoint a step that throws (it reruns on resume)", async () => {
    const store = new StateStore(dir);
    const shared = defaultSharedState();
    await expect(
      runCheckpointed(store, shared, "send", async () => {
        throw new Error("rpc down");
      }),
    ).rejects.toThrow("rpc down");
    expect(shared.steps.send).toBeUndefined();

    let runs = 0;
    const retry = await runCheckpointed(store, shared, "send", async () => {
      runs += 1;
    });
    expect(retry.ran).toBe(true);
    expect(runs).toBe(1);
  });

  it("keeps independent per-identity checkpoints (profile.alice vs profile.bob)", async () => {
    const store = new StateStore(dir);
    const shared = defaultSharedState();
    await runCheckpointed(store, shared, "profile.alice", async () => undefined);

    const reloaded = store.loadShared();
    const bob = await runCheckpointed(store, reloaded, "profile.bob", async () => undefined);
    expect(bob.ran).toBe(true);
    const alice = await runCheckpointed(store, reloaded, "profile.alice", async () => undefined);
    expect(alice.ran).toBe(false);
  });
});
