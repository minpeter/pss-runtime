import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import {
  asUint8Array,
  flattenAlphaOntoWhite,
  type RgbaImage,
  scaleRgbaNearest,
} from "./attachment-image-rgba";
import { RuntimeAttachmentStagingError } from "./attachment-types";

const JPEG_QUALITY_STEPS = [22, 28, 35, 45, 55, 65, 75, 85] as const;
const FULL_RES_PIXEL_BUDGET = 1_200_000;
const JPEG_TARGET_BPP = 0.65;
const MIN_EDGE_PX = 64;
const MAX_SCALE_ATTEMPTS = 10;

/** How prepareAttachmentBytesForStorage handled an image (or non-image). */
export type ImagePreparePath =
  | "non_image"
  | "passthrough_jpeg"
  | "passthrough_png"
  | "reencode_jpeg"
  | "reencode_png";

/** Safe, queryable fields for Workers logs / dashboards (no pixel/base64 payloads). */
export interface ImagePrepareDiagnostics {
  readonly decodedHeight?: number;
  readonly decodedWidth?: number;
  readonly hasAlpha?: boolean;
  readonly inputBytes: number;
  readonly inputMediaType: string;
  readonly maxImageBytes: number;
  readonly outputBytes: number;
  readonly outputMediaType: string;
  readonly path: ImagePreparePath;
}

export interface PreparedAttachmentBytes {
  readonly bytes: Uint8Array;
  readonly diagnostics?: ImagePrepareDiagnostics;
  readonly mediaType: string;
}
export function encodeJpegUnderBudget(
  decoded: RgbaImage,
  maxImageBytes: number
): PreparedAttachmentBytes {
  let best: Uint8Array | undefined;
  for (const frame of iterateScaledFrames(decoded, maxImageBytes)) {
    const attempt = encodeJpegMaxQualityUnderBudget(frame, maxImageBytes);
    if (!best || attempt.bytes.byteLength < best.byteLength) {
      best = attempt.bytes;
    }
    if (attempt.underBudget) {
      return { bytes: attempt.bytes, mediaType: "image/jpeg" };
    }
  }

  throw budgetError("JPEG", maxImageBytes, best);
}

/**
 * Pick highest JPEG quality under budget with minimal encodes:
 * 1) Probe max quality (camera/HEIC photos often fit in one try after scale).
 * 2) Otherwise binary-search lower steps (~log2 n probes).
 */
export function encodeJpegMaxQualityUnderBudget(
  frame: RgbaImage,
  maxImageBytes: number
): { readonly underBudget: boolean; readonly bytes: Uint8Array } {
  const last = JPEG_QUALITY_STEPS.length - 1;
  const highQuality = JPEG_QUALITY_STEPS[last] ?? 85;
  const high = encodeJpeg(frame, highQuality);
  if (high.byteLength <= maxImageBytes) {
    return { underBudget: true, bytes: high };
  }

  let bestUnder: Uint8Array | undefined;
  let bestAny: Uint8Array = high;
  let lo = 0;
  let hi = last - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const quality = JPEG_QUALITY_STEPS[mid] ?? 22;
    const encoded = encodeJpeg(frame, quality);
    if (encoded.byteLength < bestAny.byteLength) {
      bestAny = encoded;
    }
    if (encoded.byteLength <= maxImageBytes) {
      bestUnder = encoded;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestUnder) {
    return { underBudget: true, bytes: bestUnder };
  }
  return { underBudget: false, bytes: bestAny };
}

export function encodePngUnderBudget(
  decoded: RgbaImage,
  maxImageBytes: number
): PreparedAttachmentBytes {
  let best: Uint8Array | undefined;
  for (const frame of iterateScaledFrames(decoded, maxImageBytes)) {
    const encoded = encodePngRgba(frame);
    if (!best || encoded.byteLength < best.byteLength) {
      best = encoded;
    }
    if (encoded.byteLength <= maxImageBytes) {
      return { bytes: encoded, mediaType: "image/png" };
    }
  }

  // Transparent PNG still too large: flatten onto white and fall back to JPEG.
  const opaque = flattenAlphaOntoWhite(decoded);
  try {
    return encodeJpegUnderBudget(opaque, maxImageBytes);
  } catch {
    throw budgetError("PNG", maxImageBytes, best);
  }
}

/**
 * Yield progressively smaller frames. Initial scale is chosen so a moderate
 * JPEG quality is likely under budget — avoids encoding full-res noise frames.
 */
function* iterateScaledFrames(
  decoded: RgbaImage,
  maxImageBytes: number
): Generator<RgbaImage> {
  const pixelCount = Math.max(1, decoded.width * decoded.height);
  const budgetPixels = Math.max(
    MIN_EDGE_PX * MIN_EDGE_PX,
    maxImageBytes / JPEG_TARGET_BPP
  );

  let scale = 1;
  if (pixelCount > budgetPixels) {
    scale = Math.sqrt(budgetPixels / pixelCount);
  }
  if (pixelCount * scale * scale > FULL_RES_PIXEL_BUDGET) {
    scale = Math.min(scale, Math.sqrt(FULL_RES_PIXEL_BUDGET / pixelCount));
  }
  scale = Math.min(1, scale);

  for (let attempt = 0; attempt < MAX_SCALE_ATTEMPTS; attempt += 1) {
    const frame =
      scale >= 0.999
        ? decoded
        : scaleRgbaNearest(decoded.data, decoded.width, decoded.height, scale);
    yield frame;

    if (Math.min(frame.width, frame.height) <= MIN_EDGE_PX) {
      break;
    }
    // Shrink faster than linear quality steps — pure-JS encode is the bottleneck.
    scale *= 0.65;
  }
}

function budgetError(
  kind: string,
  maxImageBytes: number,
  best: Uint8Array | undefined
): RuntimeAttachmentStagingError {
  return new RuntimeAttachmentStagingError(
    `Unable to encode image attachment as ${kind} under ${maxImageBytes} bytes` +
      (best
        ? ` (smallest attempt ${best.byteLength} bytes).`
        : " (encode produced no output).")
  );
}
function encodeJpeg(image: RgbaImage, quality: number): Uint8Array {
  const encoded = jpeg.encode(
    {
      data: image.data,
      width: image.width,
      height: image.height,
    },
    quality
  );
  return asUint8Array(encoded.data);
}

function encodePngRgba(image: RgbaImage): Uint8Array {
  return encodePng({
    width: image.width,
    height: image.height,
    data: image.data,
    channels: 4,
    depth: 8,
  });
}
