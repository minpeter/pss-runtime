// biome-ignore-all lint/performance/noBarrelFile: Public compress API re-exports limits/types for stable import surface.
import { AsyncLocalStorage } from "node:async_hooks";

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
import {
  type ImagePrepareDiagnostics,
  type ImagePreparePath,
  RuntimeAttachmentImageLimitError,
} from "./attachment-types";

export type { PreparedAttachmentBytes } from "./attachment-image-encode";
export {
  assertDecodedImageWithinLimits,
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_DECODED_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_STORAGE_BUDGET_BYTES,
} from "./attachment-image-limits";
export type {
  ImagePrepareDiagnostics,
  ImagePreparePath,
} from "./attachment-types";

/**
 * Host-facing message key when logging image-prepare via the app logger
 * (e.g. worker-agent + evlog). Runtime does not print this itself.
 */
export const IMAGE_PREPARE_LOG_MESSAGE = "pss-runtime image-prepare";

/** Stored image attachments are always one of these MIME types. */
export const STORED_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type StoredImageMediaType = (typeof STORED_IMAGE_MEDIA_TYPES)[number];

export type ImagePrepareDiagnosticsListener = (
  diagnostics: ImagePrepareDiagnostics
) => void;

export type ImageOmitDiagnosticsListener = (diagnostics: {
  readonly filename?: string;
  readonly limit:
    | "decoded_pixels"
    | "input_bytes"
    | "invalid_dimensions"
    | "storage_budget";
  readonly mediaType: string;
}) => void;

/**
 * Request-scoped image-prepare collector (ALS). Hosts (e.g. worker-agent)
 * register a listener and log via their own stack (evlog wide events).
 * Runtime never hand-prints trees to stdout.
 */
const imagePrepareDiagnosticsStore =
  new AsyncLocalStorage<ImagePrepareDiagnosticsListener>();

const imageOmitDiagnosticsStore =
  new AsyncLocalStorage<ImageOmitDiagnosticsListener>();

export function runWithImagePrepareDiagnosticsListener<T>(
  listener: ImagePrepareDiagnosticsListener,
  fn: () => T
): T {
  return imagePrepareDiagnosticsStore.run(listener, fn);
}

export function runWithImageOmitDiagnosticsListener<T>(
  listener: ImageOmitDiagnosticsListener,
  fn: () => T
): T {
  return imageOmitDiagnosticsStore.run(listener, fn);
}

/** Notify host of a soft-omitted image (staging options and/or ALS). */
export function notifyImageOmitDiagnostics(diagnostics: {
  readonly filename?: string;
  readonly limit:
    | "decoded_pixels"
    | "input_bytes"
    | "invalid_dimensions"
    | "storage_budget";
  readonly mediaType: string;
}): void {
  imageOmitDiagnosticsStore.getStore()?.(diagnostics);
}

/**
 * Normalize image byte inputs for HostAttachmentStore.
 *
 * - Non-images are returned unchanged.
 * - Images are always stored as `image/jpeg` or `image/png`.
 * - Policy B: alpha → PNG, opaque → JPEG (with jpeg/png passthrough when already
 *   under budget and magic matches).
 * - HEIC/HEIF/AVIF/WebP/etc. are decoded and re-encoded (never stored as-is).
 * - Diagnostics are returned and optionally delivered to host listeners (no stdout).
 */
export async function prepareAttachmentBytesForStorage({
  bytes,
  mediaType,
  maxImageBytes = DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  onImagePrepare,
}: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly maxImageBytes?: number;
  readonly onImagePrepare?: ImagePrepareDiagnosticsListener;
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
      { log: false, onImagePrepare }
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
      },
      { onImagePrepare }
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
      },
      { onImagePrepare }
    );
  }

  const sniffed = sniffImageMediaType(bytes) ?? normalizedMediaType;
  if (needsWasmImageCodecs(sniffed, bytes)) {
    await ensureImageCodecRuntimeReady();
  }

  const decoded = await decodeImageRgba(bytes, sniffed);
  assertDecodedImageWithinLimits(decoded);
  const hasAlpha = rgbaHasTransparency(decoded.data);
  const prepared = hasAlpha
    ? encodePngUnderBudget(decoded, maxImageBytes)
    : encodeJpegUnderBudget(decoded, maxImageBytes);
  const path = resolveReencodePath(hasAlpha, prepared.mediaType);

  return withDiagnostics(
    prepared,
    {
      decodedHeight: decoded.height,
      decodedWidth: decoded.width,
      hasAlpha,
      inputBytes,
      inputMediaType: sniffed,
      maxImageBytes,
      outputBytes: prepared.bytes.byteLength,
      outputMediaType: prepared.mediaType,
      path,
    },
    { onImagePrepare }
  );
}

function resolveReencodePath(
  hasAlpha: boolean,
  outputMediaType: string
): ImagePreparePath {
  if (outputMediaType === "image/png") {
    return "reencode_png";
  }
  if (hasAlpha) {
    return "reencode_png_fallback_jpeg";
  }
  return "reencode_jpeg";
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
  options: {
    readonly log?: boolean;
    readonly onImagePrepare?: ImagePrepareDiagnosticsListener;
  } = {}
): PreparedAttachmentBytes {
  if (options.log !== false) {
    const listener =
      options.onImagePrepare ?? imagePrepareDiagnosticsStore.getStore();
    listener?.(diagnostics);
  }
  return { ...prepared, diagnostics };
}
