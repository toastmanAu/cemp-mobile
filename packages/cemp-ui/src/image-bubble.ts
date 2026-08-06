/**
 * Download lifecycle for a received image (design §3 + spec §4 item 7 / 7A).
 *
 * `error` and `unavailable` are deliberately separate. `error` is transient —
 * a dropped connection, a slow node — and retrying is worth offering.
 * `unavailable` means the sender's chunk cells are gone from chain, so the
 * bytes exist nowhere and every retry WILL fail; offering the same "tap to
 * retry" for both is how a permanently lost image spent this session looking
 * like a flaky one.
 */
export type ImageDownloadState = "idle" | "loading" | "loaded" | "error" | "unavailable";

export interface ImageBubblePresentation {
  readonly showThumbnail: boolean;
  readonly showFull: boolean;
  readonly affordance: "tap-to-load" | "tap-to-retry" | "none";
  readonly showSpinner: boolean;
}

export function imageBubbleState(input: {
  readonly hasThumbnail: boolean;
  readonly download: ImageDownloadState;
  /**
   * Sender-side bubble: the envelope is sealed to the recipient, so a
   * sender-side full-image download can never succeed — never offer the
   * tap-to-load/retry affordance on an outgoing image.
   */
  readonly outgoing?: boolean;
}): ImageBubblePresentation {
  if (input.outgoing === true) {
    return {
      showThumbnail: input.hasThumbnail,
      showFull: false,
      affordance: "none",
      showSpinner: false,
    };
  }
  switch (input.download) {
    case "idle":
      return {
        showThumbnail: input.hasThumbnail,
        showFull: false,
        affordance: "tap-to-load",
        showSpinner: false,
      };
    case "loading":
      return {
        showThumbnail: input.hasThumbnail,
        showFull: false,
        affordance: "none",
        showSpinner: true,
      };
    case "error":
      // 7A: thumbnail never leaves the manifest cell, so keep it + offer retry.
      return {
        showThumbnail: input.hasThumbnail,
        showFull: false,
        affordance: "tap-to-retry",
        showSpinner: false,
      };
    case "unavailable":
      // Keep the thumbnail (it lives in the manifest cell, not the chunks) but
      // offer NO affordance: the chunks are gone, so a retry cannot succeed.
      return {
        showThumbnail: input.hasThumbnail,
        showFull: false,
        affordance: "none",
        showSpinner: false,
      };
    case "loaded":
      return { showThumbnail: false, showFull: true, affordance: "none", showSpinner: false };
  }
}

/**
 * Classify a failed image download into the state to show and the words to
 * show with it (rule 15: no blockchain jargon; rule 2: no payload content).
 *
 * The `unavailable` branch is detected structurally — via the flag
 * `AttachmentUnavailableError` sets — rather than by matching message text,
 * so rewording the underlying error cannot silently turn a permanent failure
 * back into an endless retry prompt.
 */
export function classifyImageDownloadError(error: unknown): {
  readonly state: ImageDownloadState;
  readonly text: string;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "unavailable" in error &&
    (error as { unavailable: unknown }).unavailable === true
  ) {
    return {
      state: "unavailable",
      text: "This image is no longer available — the sender's device released it.",
    };
  }
  return {
    state: "error",
    text: "Couldn't load that image. Check your connection and tap to retry.",
  };
}
