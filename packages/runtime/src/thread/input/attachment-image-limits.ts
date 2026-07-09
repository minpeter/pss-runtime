import { RuntimeAttachmentStagingError } from "./attachment-types";

/** Default max stored size for image attachments (all hosts). */
export const DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES = 1_000_000;

/**
 * Reject raw image inputs larger than this before any decode (DoS guard).
 * Decode expands far beyond compressed size; 20MB is generous for chat photos.
 */
export const MAX_IMAGE_INPUT_BYTES = 20_000_000;

/**
 * Reject decoded frames above this pixel count before re-encode (DoS guard).
 * ~40MP covers large phone photos while bounding pure-JS RGBA memory.
 */
export const MAX_IMAGE_DECODED_PIXELS = 40_000_000;

/** Absolute ceiling for the stored-size budget option. */
export const MAX_IMAGE_STORAGE_BUDGET_BYTES = 5_000_000;

/** Exported for unit tests of the post-decode pixel DoS gate. */
export function assertDecodedImageWithinLimits(decoded: {
  readonly height: number;
  readonly width: number;
}): void {
  if (
    !Number.isFinite(decoded.width) ||
    !Number.isFinite(decoded.height) ||
    decoded.width <= 0 ||
    decoded.height <= 0
  ) {
    throw new RuntimeAttachmentStagingError(
      "Image attachment has invalid dimensions after decode."
    );
  }
  const pixels = decoded.width * decoded.height;
  if (pixels > MAX_IMAGE_DECODED_PIXELS) {
    throw new RuntimeAttachmentStagingError(
      `Image attachment exceeds max decoded pixel count of ${MAX_IMAGE_DECODED_PIXELS} (${decoded.width}x${decoded.height}).`
    );
  }
}
