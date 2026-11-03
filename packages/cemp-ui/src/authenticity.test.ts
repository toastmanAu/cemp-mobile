import { describe, expect, it } from "vitest";
import { senderAuthenticityPresentation } from "./authenticity.js";

/**
 * ADR 0007 §8 / resolved question 4: what a chat row shows about its sender.
 */
describe("senderAuthenticityPresentation", () => {
  it("a verified incoming message shows nothing extra", () => {
    expect(
      senderAuthenticityPresentation({ direction: "incoming", authStatus: "verified" }),
    ).toEqual({ kind: "none" });
  });

  it("outgoing rows and pre-upgrade rows (no status) show nothing extra", () => {
    expect(senderAuthenticityPresentation({ direction: "outgoing", authStatus: null })).toEqual({
      kind: "none",
    });
    expect(senderAuthenticityPresentation({ direction: "incoming", authStatus: null })).toEqual({
      kind: "none",
    });
  });

  it("a legacy v1/v2 message carries the exact 'Unverified (legacy)' label", () => {
    expect(
      senderAuthenticityPresentation({ direction: "incoming", authStatus: "legacy-unverified" }),
    ).toEqual({ kind: "label", label: "Unverified (legacy)" });
  });

  it("a key-changed-blocking row is a blocking card that never shows a body", () => {
    const presentation = senderAuthenticityPresentation({
      direction: "incoming",
      authStatus: "key-changed-blocking",
    });
    expect(presentation.kind).toBe("blocking-card");
    if (presentation.kind === "blocking-card") {
      expect(presentation.showBody).toBe(false);
      expect(presentation.title).toBe("Security key changed");
      expect(presentation.body).toMatch(/verify/i);
      // Rule 15: no blockchain jargon on the chat surface.
      expect(`${presentation.title} ${presentation.body}`).not.toMatch(/cell|chain|CKB|signature/i);
    }
  });

  it("an unknown future status fails closed to the blocking card", () => {
    const presentation = senderAuthenticityPresentation({
      direction: "incoming",
      authStatus: "something-newer" as never,
    });
    expect(presentation.kind).toBe("blocking-card");
  });
});
