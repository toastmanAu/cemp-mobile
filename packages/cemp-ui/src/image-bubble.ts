/** Download lifecycle for a received image (design §3 + spec §4 item 7 / 7A). */
export type ImageDownloadState = "idle" | "loading" | "loaded" | "error";

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
    case "loaded":
      return { showThumbnail: false, showFull: true, affordance: "none", showSpinner: false };
  }
}
