// biome-ignore-all lint/performance/noBarrelFile: Public compress API re-exports limits/types for stable import surface.
import {
  decodeImageRgba,
  ensureImageCodecRuntimeReady,
} from "./attachment-image-decode";
import {
  encodeJpegUnderBudget,
  encodePngUnderBudget,
  type PreparedAttachmentBytes,
} from "./attachment-image-encode";
import {
  assertDecodedImageWithinLimits,
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_STORAGE_BUDGET_BYTES,
} from "./attachment-image-limits";
import { rgbaHasTransparency } from "./attachment-image-rgba";
import {
  baseMediaType,
  isImageMediaType,
  isJpegMediaType,
  looksLikeCompleteJpeg,
  looksLikeCompletePng,
  looksLikeKnownImage,
  looksLikeOtherRaster,
  needsWasmImageCodecs,
  sniffImageMediaType,
} from "./attachment-image-sniff";
import { RuntimeAttachmentImageLimitError } from "./attachment-types";

export type { PreparedAttachmentBytes } from "./attachment-image-encode";
export {
  assertDecodedImageWithinLimits,
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_DECODED_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_STORAGE_BUDGET_BYTES,
} from "./attachment-image-limits";

/** Stored image attachments are always one of these MIME types. */
export const STORED_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type StoredImageMediaType = (typeof STORED_IMAGE_MEDIA_TYPES)[number];

/**
 * Normalize image byte inputs for HostAttachmentStore.
 *
 * - Non-images are returned unchanged.
 * - Images are always stored as `image/jpeg` or `image/png`.
 * - Policy B: alpha → PNG, opaque → JPEG (with jpeg/png passthrough when already
 *   under budget and magic matches).
 * - HEIC/HEIF/AVIF/WebP/etc. are decoded and re-encoded (never stored as-is).
 */
export async function prepareAttachmentBytesForStorage({
  bytes,
  mediaType,
  maxImageBytes = DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
}: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly maxImageBytes?: number;
}): Promise<PreparedAttachmentBytes> {
  if (
    !Number.isFinite(maxImageBytes) ||
    maxImageBytes <= 0 ||
    maxImageBytes > MAX_IMAGE_STORAGE_BUDGET_BYTES
  ) {
    throw new RuntimeAttachmentImageLimitError(
      `maxImageBytes must be a positive number ≤ ${MAX_IMAGE_STORAGE_BUDGET_BYTES}.`,
      "storage_budget"
    );
  }

  const normalizedMediaType = baseMediaType(mediaType);
  const isImage =
    isImageMediaType(normalizedMediaType) || looksLikeKnownImage(bytes);

  if (!isImage) {
    return { bytes, mediaType };
  }

  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) {
    throw new RuntimeAttachmentImageLimitError(
      `Image attachment exceeds max input size of ${MAX_IMAGE_INPUT_BYTES} bytes.`,
      "input_bytes"
    );
  }

  if (
    looksLikeCompleteJpeg(bytes) &&
    bytes.byteLength <= maxImageBytes &&
    (isJpegMediaType(normalizedMediaType) || !looksLikeOtherRaster(bytes))
  ) {
    return { bytes, mediaType: "image/jpeg" };
  }

  if (looksLikeCompletePng(bytes) && bytes.byteLength <= maxImageBytes) {
    return { bytes, mediaType: "image/png" };
  }

  const sniffed = sniffImageMediaType(bytes) ?? normalizedMediaType;
  if (needsWasmImageCodecs(sniffed, bytes)) {
    await ensureImageCodecRuntimeReady();
  }

  const decoded = await decodeImageRgba(bytes, sniffed);
  assertDecodedImageWithinLimits(decoded);
  const hasAlpha = rgbaHasTransparency(decoded.data);

  if (hasAlpha) {
    return encodePngUnderBudget(decoded, maxImageBytes);
  }
  return encodeJpegUnderBudget(decoded, maxImageBytes);
}

export function isCompressibleImageMediaType(mediaType: string): boolean {
  return isImageMediaType(baseMediaType(mediaType));
}

export function isStoredImageMediaType(
  mediaType: string
): mediaType is StoredImageMediaType {
  const normalized = baseMediaType(mediaType);
  return normalized === "image/jpeg" || normalized === "image/png";
}
