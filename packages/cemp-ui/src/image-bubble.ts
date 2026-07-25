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
}): ImageBubblePresentation {
  switch (input.download) {
    case "idle":
      return { showThumbnail: input.hasThumbnail, showFull: false, affordance: "tap-to-load", showSpinner: false };
    case "loading":
      return { showThumbnail: input.hasThumbnail, showFull: false, affordance: "none", showSpinner: true };
    case "error":
      // 7A: thumbnail never leaves the manifest cell, so keep it + offer retry.
      return { showThumbnail: input.hasThumbnail, showFull: false, affordance: "tap-to-retry", showSpinner: false };
    case "loaded":
      return { showThumbnail: false, showFull: true, affordance: "none", showSpinner: false };
  }
}
