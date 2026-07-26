import { describe, expect, it } from "vitest";
import { imageBubbleState } from "./image-bubble.js";

describe("imageBubbleState", () => {
  it("shows the thumbnail with a load affordance before download", () => {
    const s = imageBubbleState({ hasThumbnail: true, download: "idle" });
    expect(s).toEqual({
      showThumbnail: true,
      showFull: false,
      affordance: "tap-to-load",
      showSpinner: false,
    });
  });
  it("spins while downloading", () => {
    expect(imageBubbleState({ hasThumbnail: true, download: "loading" })).toEqual({
      showThumbnail: true,
      showFull: false,
      affordance: "none",
      showSpinner: true,
    });
  });
  it("keeps the thumbnail and offers retry on failure (7A)", () => {
    expect(imageBubbleState({ hasThumbnail: true, download: "error" })).toEqual({
      showThumbnail: true,
      showFull: false,
      affordance: "tap-to-retry",
      showSpinner: false,
    });
  });
  it("shows the full image once loaded", () => {
    expect(imageBubbleState({ hasThumbnail: true, download: "loaded" })).toEqual({
      showThumbnail: false,
      showFull: true,
      affordance: "none",
      showSpinner: false,
    });
  });
  it("never offers tap-to-load on an outgoing image (envelope is sealed to the recipient)", () => {
    // Sender-side deriveIncomingAttachmentKey throws by construction — the
    // tap could only produce a spinner → "Tap to retry" loop on a
    // successfully-sent image.
    for (const download of ["idle", "loading", "error", "loaded"] as const) {
      expect(imageBubbleState({ hasThumbnail: true, download, outgoing: true })).toEqual({
        showThumbnail: true,
        showFull: false,
        affordance: "none",
        showSpinner: false,
      });
    }
  });
});
