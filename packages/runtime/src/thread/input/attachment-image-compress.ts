import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { RuntimeAttachmentStagingError } from "./attachment-types";

/** Default max stored size for image attachments (all hosts). */
export const DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES = 1_000_000;

/** Stored image attachments are always one of these MIME types. */
export const STORED_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type StoredImageMediaType = (typeof STORED_IMAGE_MEDIA_TYPES)[number];

const QUALITY_STEPS = [85, 75, 65, 55, 45, 35, 28, 22] as const;
/** Skip full-resolution encodes for very large frames (pure-JS codecs are slow). */
const FULL_RES_PIXEL_BUDGET = 1_600_000;
const MIN_EDGE_PX = 64;

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
  if (maxImageBytes <= 0) {
    throw new RuntimeAttachmentStagingError(
      "maxImageBytes must be a positive number."
    );
  }

  const normalizedMediaType = mediaType.trim().toLowerCase();
  const isImage =
    isImageMediaType(normalizedMediaType) || looksLikeKnownImage(bytes);

  if (!isImage) {
    return { bytes, mediaType };
  }

  // Passthrough: already JPEG under budget.
  if (
    looksLikeJpeg(bytes) &&
    bytes.byteLength <= maxImageBytes &&
    (isJpegMediaType(normalizedMediaType) || !looksLikeOtherRaster(bytes))
  ) {
    return { bytes, mediaType: "image/jpeg" };
  }

  // Passthrough: already PNG under budget.
  if (looksLikePng(bytes) && bytes.byteLength <= maxImageBytes) {
    return { bytes, mediaType: "image/png" };
  }

  const decoded = await decodeImageRgba(
    bytes,
    sniffImageMediaType(bytes) ?? normalizedMediaType
  );
  const hasAlpha = rgbaHasTransparency(decoded.data);

  if (hasAlpha) {
    return encodePngUnderBudget(decoded, maxImageBytes);
  }
  return encodeJpegUnderBudget(decoded, maxImageBytes);
}

export function isCompressibleImageMediaType(mediaType: string): boolean {
  return isImageMediaType(mediaType.trim().toLowerCase());
}

export function isStoredImageMediaType(
  mediaType: string
): mediaType is StoredImageMediaType {
  const normalized = mediaType.trim().toLowerCase();
  return normalized === "image/jpeg" || normalized === "image/png";
}

function isImageMediaType(normalized: string): boolean {
  return (
    isJpegMediaType(normalized) ||
    isPngMediaType(normalized) ||
    normalized === "image/webp" ||
    normalized === "image/gif" ||
    normalized === "image/bmp" ||
    normalized === "image/heic" ||
    normalized === "image/heif" ||
    normalized === "image/heic-sequence" ||
    normalized === "image/heif-sequence" ||
    normalized === "image/avif" ||
    normalized === "image/avif-sequence" ||
    normalized.startsWith("image/")
  );
}

function isJpegMediaType(normalized: string): boolean {
  return normalized === "image/jpeg" || normalized === "image/jpg";
}

function isPngMediaType(normalized: string): boolean {
  return normalized === "image/png" || normalized === "image/x-png";
}

function encodeJpegUnderBudget(
  decoded: RgbaImage,
  maxImageBytes: number
): PreparedAttachmentBytes {
  let best: Uint8Array | undefined;
  for (const frame of iterateScaledFrames(decoded)) {
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

  throw budgetError("JPEG", maxImageBytes, best);
}

function encodePngUnderBudget(
  decoded: RgbaImage,
  maxImageBytes: number
): PreparedAttachmentBytes {
  let best: Uint8Array | undefined;
  for (const frame of iterateScaledFrames(decoded)) {
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

function* iterateScaledFrames(decoded: RgbaImage): Generator<RgbaImage> {
  const pixelCount = decoded.width * decoded.height;
  let scale =
    pixelCount > FULL_RES_PIXEL_BUDGET
      ? Math.sqrt(FULL_RES_PIXEL_BUDGET / pixelCount)
      : 1;

  // Always attempt at least one full (or budgeted) frame, then keep shrinking.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const frame =
      scale >= 0.999
        ? decoded
        : scaleRgbaNearest(decoded.data, decoded.width, decoded.height, scale);
    yield frame;

    if (Math.min(frame.width, frame.height) <= MIN_EDGE_PX) {
      break;
    }
    scale *= 0.7;
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
      isJpegMediaType(normalized) ||
      looksLikeJpeg(bytes)
    ) {
      return decodeJpegToRgba(bytes);
    }

    if (isPngMediaType(normalized) || looksLikePng(bytes)) {
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

    if (normalized === "image/webp" || looksLikeWebp(bytes)) {
      return await decodeWebpToRgba(bytes);
    }

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
    if (looksLikeWebp(bytes)) {
      return await decodeWebpToRgba(bytes);
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
      `Unable to decode image attachment for normalization (${mediaType}): ${detail}`
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
    buffer: bytes as unknown as ArrayBuffer,
  });
  return {
    data: asUint8Array(decoded.data),
    height: decoded.height,
    width: decoded.width,
  };
}

let avifDecoderReady: Promise<void> | undefined;
let webpDecoderReady: Promise<void> | undefined;

async function ensureAvifDecoderInitialized(): Promise<void> {
  if (!avifDecoderReady) {
    avifDecoderReady = initJsquashDecoder("@jsquash/avif", "avif_dec.wasm");
  }
  await avifDecoderReady;
}

async function ensureWebpDecoderInitialized(): Promise<void> {
  if (!webpDecoderReady) {
    webpDecoderReady = initJsquashDecoder("@jsquash/webp", "webp_dec.wasm");
  }
  await webpDecoderReady;
}

async function initJsquashDecoder(
  packageName: "@jsquash/avif" | "@jsquash/webp",
  wasmFileName: string
): Promise<void> {
  const mod =
    packageName === "@jsquash/avif"
      ? await import("@jsquash/avif/decode.js")
      : await import("@jsquash/webp/decode.js");
  try {
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve(`${packageName}/package.json`));
    const wasmPath = path.join(pkgDir, "codec/dec", wasmFileName);
    const wasmBytes = readFileSync(wasmPath);
    await mod.init(await WebAssembly.compile(wasmBytes));
  } catch {
    await mod.init();
  }
}

async function decodeAvifToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  await ensureAvifDecoderInitialized();
  const { default: decode } = await import("@jsquash/avif/decode.js");
  const decoded = await decode(toArrayBuffer(bytes));
  if (!decoded) {
    throw new Error("AVIF decoder returned no image data.");
  }
  return {
    data: asUint8Array(decoded.data),
    height: decoded.height,
    width: decoded.width,
  };
}

async function decodeWebpToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  await ensureWebpDecoderInitialized();
  const { default: decode } = await import("@jsquash/webp/decode.js");
  const decoded = await decode(toArrayBuffer(bytes));
  if (!decoded) {
    throw new Error("WebP decoder returned no image data.");
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

function encodePngRgba(image: RgbaImage): Uint8Array {
  return encodePng({
    width: image.width,
    height: image.height,
    data: image.data,
    channels: 4,
    depth: 8,
  });
}

function rgbaHasTransparency(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 255) {
      return true;
    }
  }
  return false;
}

function flattenAlphaOntoWhite(image: RgbaImage): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const a = (image.data[i + 3] ?? 255) / 255;
    data[i] = Math.round((image.data[i] ?? 0) * a + 255 * (1 - a));
    data[i + 1] = Math.round((image.data[i + 1] ?? 0) * a + 255 * (1 - a));
    data[i + 2] = Math.round((image.data[i + 2] ?? 0) * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
  return { data, height: image.height, width: image.width };
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

function looksLikeKnownImage(bytes: Uint8Array): boolean {
  return (
    looksLikeJpeg(bytes) ||
    looksLikePng(bytes) ||
    looksLikeHeic(bytes) ||
    looksLikeAvif(bytes) ||
    looksLikeWebp(bytes)
  );
}

function looksLikeOtherRaster(bytes: Uint8Array): boolean {
  return (
    looksLikePng(bytes) ||
    looksLikeHeic(bytes) ||
    looksLikeAvif(bytes) ||
    looksLikeWebp(bytes)
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
  if (looksLikeWebp(bytes)) {
    return "image/webp";
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

function looksLikeWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }
  const riff = String.fromCharCode(
    bytes[0] ?? 0,
    bytes[1] ?? 0,
    bytes[2] ?? 0,
    bytes[3] ?? 0
  );
  const webp = String.fromCharCode(
    bytes[8] ?? 0,
    bytes[9] ?? 0,
    bytes[10] ?? 0,
    bytes[11] ?? 0
  );
  return riff === "RIFF" && webp === "WEBP";
}

function looksLikeHeic(bytes: Uint8Array): boolean {
  return isIsoBmffBrand(bytes, HEIC_BRANDS);
}

function looksLikeAvif(bytes: Uint8Array): boolean {
  return isIsoBmffBrand(bytes, AVIF_BRANDS);
}

function isIsoBmffBrand(
  bytes: Uint8Array,
  brands: ReadonlySet<string>
): boolean {
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
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
