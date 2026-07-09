import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import { RuntimeAttachmentStagingError } from "./attachment-types";

/** Default max stored size for image attachments (all hosts). */
export const DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES = 1_000_000;

const QUALITY_STEPS = [80, 60, 45, 32, 22] as const;
const SCALE_STEPS = [1, 0.75, 0.55, 0.4, 0.28, 0.18] as const;
/** Skip full-resolution encodes for very large frames (pure-JS JPEG is slow). */
const FULL_RES_PIXEL_BUDGET = 1_600_000;

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
]);

const AVIF_BRANDS = new Set(["avif", "avis"]);

export interface PreparedAttachmentBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/**
 * Ensure image bytes fit within maxImageBytes by re-encoding (and scaling if
 * needed). Non-images and already-small images are returned unchanged.
 *
 * Supported for oversize compression: JPEG, PNG, HEIC/HEIF, AVIF (decoded then
 * stored as JPEG). WebP/GIF/BMP remain best-effort via signature sniffing.
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
  if (!isCompressibleImageMediaType(mediaType) && !looksLikeCompressibleImage(bytes)) {
    return { bytes, mediaType };
  }
  // Treat signature-detected images as compressible even if mediaType was wrong.
  const effectiveMediaType = isCompressibleImageMediaType(mediaType)
    ? mediaType
    : sniffImageMediaType(bytes) ?? mediaType;

  if (!isCompressibleImageMediaType(effectiveMediaType)) {
    return { bytes, mediaType };
  }

  if (bytes.byteLength <= maxImageBytes) {
    return { bytes, mediaType: effectiveMediaType };
  }
  if (maxImageBytes <= 0) {
    throw new RuntimeAttachmentStagingError(
      "maxImageBytes must be a positive number."
    );
  }

  return await compressImageToMaxBytes(bytes, effectiveMediaType, maxImageBytes);
}

export function isCompressibleImageMediaType(mediaType: string): boolean {
  const normalized = mediaType.trim().toLowerCase();
  return (
    normalized === "image/jpeg" ||
    normalized === "image/jpg" ||
    normalized === "image/png" ||
    normalized === "image/x-png" ||
    normalized === "image/webp" ||
    normalized === "image/gif" ||
    normalized === "image/bmp" ||
    normalized === "image/heic" ||
    normalized === "image/heif" ||
    normalized === "image/heic-sequence" ||
    normalized === "image/heif-sequence" ||
    normalized === "image/avif" ||
    normalized === "image/avif-sequence"
  );
}

async function compressImageToMaxBytes(
  bytes: Uint8Array,
  mediaType: string,
  maxImageBytes: number
): Promise<PreparedAttachmentBytes> {
  const decoded = await decodeImageRgba(bytes, mediaType);
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

async function decodeImageRgba(
  bytes: Uint8Array,
  mediaType: string
): Promise<RgbaImage> {
  const normalized = mediaType.trim().toLowerCase();
  try {
    if (
      normalized === "image/jpeg" ||
      normalized === "image/jpg" ||
      looksLikeJpeg(bytes)
    ) {
      return decodeJpegToRgba(bytes);
    }

    if (
      normalized === "image/png" ||
      normalized === "image/x-png" ||
      looksLikePng(bytes)
    ) {
      return decodePngToRgba(bytes);
    }

    if (
      normalized === "image/heic" ||
      normalized === "image/heif" ||
      normalized === "image/heic-sequence" ||
      normalized === "image/heif-sequence" ||
      looksLikeHeic(bytes)
    ) {
      return await decodeHeicToRgba(bytes);
    }

    if (
      normalized === "image/avif" ||
      normalized === "image/avif-sequence" ||
      looksLikeAvif(bytes)
    ) {
      return await decodeAvifToRgba(bytes);
    }

    // webp/gif/bmp: signature fallbacks only
    if (looksLikeJpeg(bytes)) {
      return decodeJpegToRgba(bytes);
    }
    if (looksLikePng(bytes)) {
      return decodePngToRgba(bytes);
    }
    if (looksLikeHeic(bytes)) {
      return await decodeHeicToRgba(bytes);
    }
    if (looksLikeAvif(bytes)) {
      return await decodeAvifToRgba(bytes);
    }

    throw new Error(
      `No decoder available for media type ${mediaType} (and no recognized image signature).`
    );
  } catch (error) {
    if (error instanceof RuntimeAttachmentStagingError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeAttachmentStagingError(
      `Unable to decode image attachment for compression (${mediaType}): ${detail}`
    );
  }
}

function decodeJpegToRgba(bytes: Uint8Array): RgbaImage {
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

async function decodeHeicToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  const decode = (await import("heic-decode")).default;
  const decoded = await decode({
    // libheif accepts Uint8Array-backed buffers
    buffer: bytes as unknown as ArrayBuffer,
  });
  return {
    data: asUint8Array(decoded.data),
    height: decoded.height,
    width: decoded.width,
  };
}

let avifDecoderReady: Promise<void> | undefined;

async function ensureAvifDecoderInitialized(): Promise<void> {
  if (!avifDecoderReady) {
    avifDecoderReady = (async () => {
      const mod = await import("@jsquash/avif/decode.js");
      try {
        const { createRequire } = await import("node:module");
        const { readFileSync } = await import("node:fs");
        const path = await import("node:path");
        const require = createRequire(import.meta.url);
        const pkgDir = path.dirname(
          require.resolve("@jsquash/avif/package.json")
        );
        const wasmPath = path.join(pkgDir, "codec/dec/avif_dec.wasm");
        const wasmBytes = readFileSync(wasmPath);
        await mod.init(await WebAssembly.compile(wasmBytes));
      } catch {
        // Bundlers / Workers: default init may resolve wasm via import.
        await mod.init();
      }
    })();
  }
  await avifDecoderReady;
}

async function decodeAvifToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  await ensureAvifDecoderInitialized();
  const { default: decode } = await import("@jsquash/avif/decode.js");
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const decoded = await decode(buffer);
  if (!decoded) {
    throw new Error("AVIF decoder returned no image data.");
  }
  return {
    data: asUint8Array(decoded.data),
    height: decoded.height,
    width: decoded.width,
  };
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

function looksLikeCompressibleImage(bytes: Uint8Array): boolean {
  return (
    looksLikeJpeg(bytes) ||
    looksLikePng(bytes) ||
    looksLikeHeic(bytes) ||
    looksLikeAvif(bytes)
  );
}

function sniffImageMediaType(bytes: Uint8Array): string | undefined {
  if (looksLikeJpeg(bytes)) {
    return "image/jpeg";
  }
  if (looksLikePng(bytes)) {
    return "image/png";
  }
  if (looksLikeHeic(bytes)) {
    return "image/heic";
  }
  if (looksLikeAvif(bytes)) {
    return "image/avif";
  }
  return;
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

function looksLikeHeic(bytes: Uint8Array): boolean {
  return isIsoBmffBrand(bytes, HEIC_BRANDS);
}

function looksLikeAvif(bytes: Uint8Array): boolean {
  return isIsoBmffBrand(bytes, AVIF_BRANDS);
}

function isIsoBmffBrand(bytes: Uint8Array, brands: ReadonlySet<string>): boolean {
  if (bytes.length < 12) {
    return false;
  }
  const box = String.fromCharCode(
    bytes[4] ?? 0,
    bytes[5] ?? 0,
    bytes[6] ?? 0,
    bytes[7] ?? 0
  );
  if (box !== "ftyp") {
    return false;
  }
  const brand = String.fromCharCode(
    bytes[8] ?? 0,
    bytes[9] ?? 0,
    bytes[10] ?? 0,
    bytes[11] ?? 0
  )
    .replaceAll("\0", " ")
    .trim();
  return brands.has(brand);
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
