// biome-ignore-all lint/performance/noBarrelFile: Public compress API re-exports limits/types for stable import surface.
import {
  decodeImageRgba,
  ensureImageCodecRuntimeReady,
} from "./attachment-image-decode";
import {
  encodeJpegUnderBudget,
  encodePngUnderBudget,
  type ImagePrepareDiagnostics,
  type ImagePreparePath,
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

export type {
  ImagePrepareDiagnostics,
  ImagePreparePath,
  PreparedAttachmentBytes,
} from "./attachment-image-encode";
export {
  assertDecodedImageWithinLimits,
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_DECODED_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_STORAGE_BUDGET_BYTES,
} from "./attachment-image-limits";

/** Structured log message key for Workers Observability / wrangler tail. */
export const IMAGE_PREPARE_LOG_MESSAGE = "pss-runtime image-prepare";

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
 * - Emits a structured `pss-runtime image-prepare` log for image inputs (no bytes).
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
  const inputBytes = bytes.byteLength;
  const isImage =
    isImageMediaType(normalizedMediaType) || looksLikeKnownImage(bytes);

  if (!isImage) {
    return withDiagnostics(
      { bytes, mediaType },
      {
        inputBytes,
        inputMediaType: normalizedMediaType,
        maxImageBytes,
        outputBytes: inputBytes,
        outputMediaType: mediaType,
        path: "non_image",
      },
      { log: false }
    );
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
    return withDiagnostics(
      { bytes, mediaType: "image/jpeg" },
      {
        inputBytes,
        inputMediaType: normalizedMediaType,
        maxImageBytes,
        outputBytes: inputBytes,
        outputMediaType: "image/jpeg",
        path: "passthrough_jpeg",
      }
    );
  }

  if (looksLikeCompletePng(bytes) && bytes.byteLength <= maxImageBytes) {
    return withDiagnostics(
      { bytes, mediaType: "image/png" },
      {
        inputBytes,
        inputMediaType: normalizedMediaType,
        maxImageBytes,
        outputBytes: inputBytes,
        outputMediaType: "image/png",
        path: "passthrough_png",
      }
    );
  }

  const sniffed = sniffImageMediaType(bytes) ?? normalizedMediaType;
  if (needsWasmImageCodecs(sniffed, bytes)) {
    await ensureImageCodecRuntimeReady();
  }

  const decoded = await decodeImageRgba(bytes, sniffed);
  assertDecodedImageWithinLimits(decoded);
  const hasAlpha = rgbaHasTransparency(decoded.data);
  const path: ImagePreparePath = hasAlpha ? "reencode_png" : "reencode_jpeg";
  const prepared = hasAlpha
    ? encodePngUnderBudget(decoded, maxImageBytes)
    : encodeJpegUnderBudget(decoded, maxImageBytes);

  return withDiagnostics(prepared, {
    decodedHeight: decoded.height,
    decodedWidth: decoded.width,
    hasAlpha,
    inputBytes,
    inputMediaType: sniffed,
    maxImageBytes,
    outputBytes: prepared.bytes.byteLength,
    outputMediaType: prepared.mediaType,
    path,
  });
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

function withDiagnostics(
  prepared: PreparedAttachmentBytes,
  diagnostics: ImagePrepareDiagnostics,
  options: { readonly log?: boolean } = {}
): PreparedAttachmentBytes {
  if (options.log !== false) {
    console.info(IMAGE_PREPARE_LOG_MESSAGE, diagnostics);
  }
  return { ...prepared, diagnostics };
}
