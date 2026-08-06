import { describe, expect, it } from "vitest";
import { classifyImageDownloadError, imageBubbleState } from "./image-bubble.js";

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
  it("keeps the thumbnail but offers NO retry once the chunks are gone", () => {
    // The thumbnail lives in the manifest cell, not the chunk cells, so it
    // survives the sender's reclaim — but the full image never can, and
    // inviting a retry that is guaranteed to fail is what made a permanently
    // lost image look like a flaky download.
    expect(imageBubbleState({ hasThumbnail: true, download: "unavailable" })).toEqual({
      showThumbnail: true,
      showFull: false,
      affordance: "none",
      showSpinner: false,
    });
  });
});

describe("classifyImageDownloadError", () => {
  it("treats a chunk-gone failure as permanently unavailable", () => {
    // The shape `AttachmentUnavailableError` carries (@cemp/images). Matched
    // structurally rather than on message text, so rewording the underlying
    // error cannot silently turn a permanent failure back into a retry loop.
    const error = Object.assign(new Error("attachment chunk 0 is not live"), {
      unavailable: true,
    });
    const result = classifyImageDownloadError(error);
    expect(result.state).toBe("unavailable");
    expect(result.text).toMatch(/no longer available/i);
    // Rule 15: no blockchain jargon in ordinary chat copy.
    expect(result.text).not.toMatch(/cell|outpoint|chunk|reclaim|chain/i);
  });

  it("treats anything else as a retryable error", () => {
    const result = classifyImageDownloadError(new Error("socket hang up"));
    expect(result.state).toBe("error");
    expect(result.text).toMatch(/retry/i);
  });

  it("does not mistake a non-error value for an unavailable attachment", () => {
    // Odd/hostile inputs must fall through to the retryable branch rather than
    // telling the user their image is gone forever (rule 4).
    expect(classifyImageDownloadError(null).state).toBe("error");
    expect(classifyImageDownloadError("unavailable").state).toBe("error");
    expect(classifyImageDownloadError({ unavailable: "yes" }).state).toBe("error");
  });
});
