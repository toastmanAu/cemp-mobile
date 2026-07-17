import { describe, expect, it } from "vitest";
import {
  canTransitionMessage,
  INCOMING_MESSAGE_STATES,
  initialMessageState,
  isIncomingState,
  isOutgoingState,
  OUTGOING_MESSAGE_STATES,
  TERMINAL_MESSAGE_STATES,
  type IncomingMessageState,
  type OutgoingMessageState,
} from "./message-states.js";

/** The §11 state machine as a pure function — exhaustively checked. */
describe("message state machines (spec §11)", () => {
  it("covers the full §11 state lists", () => {
    expect(OUTGOING_MESSAGE_STATES).toHaveLength(16);
    expect(INCOMING_MESSAGE_STATES).toHaveLength(10);
    expect(isOutgoingState("pending")).toBe(true);
    expect(isIncomingState("received")).toBe(true);
    expect(isOutgoingState("received")).toBe(false);
    expect(isIncomingState("pending")).toBe(false);
  });

  it("follows the outgoing happy path draft → … → reclaimed", () => {
    const path: OutgoingMessageState[] = [
      "draft",
      "queued",
      "encrypting",
      "building_transaction",
      "awaiting_signature",
      "submitting",
      "pending",
      "committed",
      "available_on_chain",
      "downloaded_by_recipient",
      "acknowledged",
      "reclaim_queued",
      "reclaim_pending",
      "reclaimed",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(
        canTransitionMessage("outgoing", path[i]!, path[i + 1]!),
        `${path[i]} → ${path[i + 1]}`,
      ).toBe(true);
    }
  });

  it("follows the incoming happy path discovered → … → remote_reclaimed", () => {
    const path: IncomingMessageState[] = [
      "discovered",
      "downloading",
      "decrypting",
      "received",
      "displayed",
      "response_queued",
      "response_sent",
      "awaiting_remote_reclaim",
      "remote_reclaimed",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(
        canTransitionMessage("incoming", path[i]!, path[i + 1]!),
        `${path[i]} → ${path[i + 1]}`,
      ).toBe(true);
    }
  });

  it("rejects skipped, backwards and cross-direction transitions", () => {
    expect(canTransitionMessage("outgoing", "draft", "pending")).toBe(false);
    expect(canTransitionMessage("outgoing", "pending", "draft")).toBe(false);
    expect(canTransitionMessage("outgoing", "committed", "reclaimed")).toBe(false);
    expect(canTransitionMessage("outgoing", "draft", "received")).toBe(false);
    expect(canTransitionMessage("incoming", "received", "pending")).toBe(false);
    expect(canTransitionMessage("incoming", "remote_reclaimed", "discovered")).toBe(false);
  });

  it("terminal states have no outbound transitions", () => {
    for (const state of TERMINAL_MESSAGE_STATES) {
      for (const target of OUTGOING_MESSAGE_STATES) {
        expect(canTransitionMessage("outgoing", state, target)).toBe(false);
      }
      for (const target of INCOMING_MESSAGE_STATES) {
        expect(canTransitionMessage("incoming", state, target)).toBe(false);
      }
    }
  });

  it("failed is reachable from every in-flight outgoing state; expired from pre-commit", () => {
    const inFlight: OutgoingMessageState[] = [
      "draft",
      "queued",
      "encrypting",
      "building_transaction",
      "awaiting_signature",
      "submitting",
      "pending",
      "committed",
      "available_on_chain",
      "downloaded_by_recipient",
      "acknowledged",
      "reclaim_queued",
      "reclaim_pending",
    ];
    for (const state of inFlight) {
      expect(canTransitionMessage("outgoing", state, "failed"), `${state} → failed`).toBe(true);
    }
    expect(canTransitionMessage("outgoing", "pending", "expired")).toBe(true);
    expect(canTransitionMessage("outgoing", "committed", "expired")).toBe(false);
  });

  it("initial states match the direction", () => {
    expect(initialMessageState("outgoing")).toBe("draft");
    expect(initialMessageState("incoming")).toBe("discovered");
  });
});
