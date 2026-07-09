import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import { RuntimeAttachmentStagingError } from "./attachment-types";

/** Default max stored size for image attachments (all hosts). */
export const DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES = 1_000_000;

const QUALITY_STEPS = [80, 60, 45, 32, 22] as const;
const SCALE_STEPS = [1, 0.75, 0.55, 0.4, 0.28, 0.18] as const;
/** Skip full-resolution encodes for very large frames (pure-JS JPEG is slow). */
const FULL_RES_PIXEL_BUDGET = 1_600_000;

export interface PreparedAttachmentBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/**
 * Ensure image bytes fit within maxImageBytes by re-encoding (and scaling if
 * needed). Non-images and already-small images are returned unchanged.
 */
export function prepareAttachmentBytesForStorage({
  bytes,
  mediaType,
  maxImageBytes = DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
}: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly maxImageBytes?: number;
}): PreparedAttachmentBytes {
  if (!isCompressibleImageMediaType(mediaType)) {
    return { bytes, mediaType };
  }
  if (bytes.byteLength <= maxImageBytes) {
    return { bytes, mediaType };
  }
  if (maxImageBytes <= 0) {
    throw new RuntimeAttachmentStagingError(
      "maxImageBytes must be a positive number."
    );
  }

  return compressImageToMaxBytes(bytes, mediaType, maxImageBytes);
}

export function isCompressibleImageMediaType(mediaType: string): boolean {
  const normalized = mediaType.trim().toLowerCase();
  return (
    normalized === "image/jpeg" ||
    normalized === "image/jpg" ||
    normalized === "image/png" ||
    normalized === "image/webp" ||
    normalized === "image/gif" ||
    normalized === "image/bmp" ||
    normalized === "image/x-png"
  );
}

function compressImageToMaxBytes(
  bytes: Uint8Array,
  mediaType: string,
  maxImageBytes: number
): PreparedAttachmentBytes {
  const decoded = decodeImageRgba(bytes, mediaType);
  let best: Uint8Array | undefined;
  const pixelCount = decoded.width * decoded.height;
  const scales =
    pixelCount > FULL_RES_PIXEL_BUDGET
      ? SCALE_STEPS.filter((scale) => scale < 1)
      : SCALE_STEPS;

  for (const scale of scales) {
    const frame =
      scale === 1
        ? decoded
        : scaleRgbaNearest(decoded.data, decoded.width, decoded.height, scale);

    for (const quality of QUALITY_STEPS) {
      const encoded = encodeJpeg(frame, quality);
      if (!best || encoded.byteLength < best.byteLength) {
        best = encoded;
      }
      if (encoded.byteLength <= maxImageBytes) {
        return { bytes: encoded, mediaType: "image/jpeg" };
      }
    }
  }

  throw new RuntimeAttachmentStagingError(
    `Unable to compress image attachment under ${maxImageBytes} bytes` +
      (best
        ? ` (smallest attempt ${best.byteLength} bytes).`
        : " (encode produced no output).")
  );
}

interface RgbaImage {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

function decodeImageRgba(bytes: Uint8Array, mediaType: string): RgbaImage {
  const normalized = mediaType.trim().toLowerCase();
  try {
    if (
      normalized === "image/jpeg" ||
      normalized === "image/jpg" ||
      looksLikeJpeg(bytes)
    ) {
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
      });
      return {
        data: asUint8Array(decoded.data),
        height: decoded.height,
        width: decoded.width,
      };
    }

    if (
      normalized === "image/png" ||
      normalized === "image/x-png" ||
      looksLikePng(bytes)
    ) {
      return decodePngToRgba(bytes);
    }

    // webp/gif/bmp: try JPEG then PNG signatures / decoders
    if (looksLikeJpeg(bytes)) {
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
      });
      return {
        data: asUint8Array(decoded.data),
        height: decoded.height,
        width: decoded.width,
      };
    }
    return decodePngToRgba(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeAttachmentStagingError(
      `Unable to decode image attachment for compression (${mediaType}): ${detail}`
    );
  }
}

function decodePngToRgba(bytes: Uint8Array): RgbaImage {
  const decoded = decodePng(bytes);
  const channels = decoded.channels;
  const pixelCount = decoded.width * decoded.height;
  const source = asUint8Array(decoded.data);

  if (channels === 4) {
    return {
      data: source,
      height: decoded.height,
      width: decoded.width,
    };
  }

  const rgba = new Uint8Array(pixelCount * 4);
  if (channels === 3) {
    for (let i = 0, j = 0; i < pixelCount; i += 1, j += 3) {
      const o = i * 4;
      rgba[o] = source[j] ?? 0;
      rgba[o + 1] = source[j + 1] ?? 0;
      rgba[o + 2] = source[j + 2] ?? 0;
      rgba[o + 3] = 255;
    }
  } else if (channels === 1) {
    for (let i = 0; i < pixelCount; i += 1) {
      const v = source[i] ?? 0;
      const o = i * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  } else if (channels === 2) {
    for (let i = 0, j = 0; i < pixelCount; i += 1, j += 2) {
      const v = source[j] ?? 0;
      const o = i * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = source[j + 1] ?? 255;
    }
  } else {
    throw new Error(`Unsupported PNG channel count: ${channels}`);
  }

  return {
    data: rgba,
    height: decoded.height,
    width: decoded.width,
  };
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

function scaleRgbaNearest(
  data: Uint8Array,
  width: number,
  height: number,
  scale: number
): RgbaImage {
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(nextWidth * nextHeight * 4);
  const xRatio = width / nextWidth;
  const yRatio = height / nextHeight;

  for (let y = 0; y < nextHeight; y += 1) {
    const srcY = Math.min(height - 1, Math.floor(y * yRatio));
    for (let x = 0; x < nextWidth; x += 1) {
      const srcX = Math.min(width - 1, Math.floor(x * xRatio));
      const src = (srcY * width + srcX) * 4;
      const dst = (y * nextWidth + x) * 4;
      out[dst] = data[src] ?? 0;
      out[dst + 1] = data[src + 1] ?? 0;
      out[dst + 2] = data[src + 2] ?? 0;
      out[dst + 3] = data[src + 3] ?? 255;
    }
  }

  return { data: out, height: nextHeight, width: nextWidth };
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function looksLikePng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function asUint8Array(
  value: ArrayBuffer | ArrayBufferView | Uint8Array
): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}
