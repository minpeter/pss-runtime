import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import {
  getInstalledImageCodecWasm,
  hasAvifDecodeWasm,
  hasHeifDecodeWasm,
  hasWebpDecodeWasm,
  installImageCodecWasmFromNodeModules,
} from "./attachment-image-codec-registry";
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

/** Stored image attachments are always one of these MIME types. */
export const STORED_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type StoredImageMediaType = (typeof STORED_IMAGE_MEDIA_TYPES)[number];

/**
 * JPEG quality ladder (ascending). Binary-searched so large frames cost
 * ~log2(n) encodes instead of n linear probes.
 */
const JPEG_QUALITY_STEPS = [22, 28, 35, 45, 55, 65, 75, 85] as const;
/**
 * Cap pure-JS JPEG encode cost. Attachment vision quality stays fine around
 * ~1MP; going higher burns CPU with little storage benefit under the 1MB cap.
 */
const FULL_RES_PIXEL_BUDGET = 1_200_000;
/** Target bytes/pixel when picking the first scale for JPEG under budget. */
const JPEG_TARGET_BPP = 0.65;
const MIN_EDGE_PX = 64;
const MAX_SCALE_ATTEMPTS = 10;

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
  if (
    !Number.isFinite(maxImageBytes) ||
    maxImageBytes <= 0 ||
    maxImageBytes > MAX_IMAGE_STORAGE_BUDGET_BYTES
  ) {
    throw new RuntimeAttachmentStagingError(
      `maxImageBytes must be a positive number ≤ ${MAX_IMAGE_STORAGE_BUDGET_BYTES}.`
    );
  }

  // Strip `; charset=…` / other parameters — clients often send them.
  const normalizedMediaType = baseMediaType(mediaType);
  const isImage =
    isImageMediaType(normalizedMediaType) || looksLikeKnownImage(bytes);

  if (!isImage) {
    return { bytes, mediaType };
  }

  // Pre-decode raw size gate (DoS): reject before allocating decoder state.
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) {
    throw new RuntimeAttachmentStagingError(
      `Image attachment exceeds max input size of ${MAX_IMAGE_INPUT_BYTES} bytes.`
    );
  }

  // Passthrough: complete JPEG under budget (EOI required — reject truncated).
  // Skip wasm bootstrap on the hot path for already-valid small JPEG/PNG.
  if (
    looksLikeCompleteJpeg(bytes) &&
    bytes.byteLength <= maxImageBytes &&
    (isJpegMediaType(normalizedMediaType) || !looksLikeOtherRaster(bytes))
  ) {
    return { bytes, mediaType: "image/jpeg" };
  }

  // Passthrough: complete PNG under budget (IEND required — reject truncated).
  if (looksLikeCompletePng(bytes) && bytes.byteLength <= maxImageBytes) {
    return { bytes, mediaType: "image/png" };
  }

  const sniffed = sniffImageMediaType(bytes) ?? normalizedMediaType;
  // Only load AVIF/WebP/HEIF wasm when those formats may be involved.
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

export function isCompressibleImageMediaType(mediaType: string): boolean {
  return isImageMediaType(baseMediaType(mediaType));
}

export function isStoredImageMediaType(
  mediaType: string
): mediaType is StoredImageMediaType {
  const normalized = baseMediaType(mediaType);
  return normalized === "image/jpeg" || normalized === "image/png";
}

/** `image/jpeg; charset=binary` → `image/jpeg` */
function baseMediaType(mediaType: string): string {
  const trimmed = mediaType.trim().toLowerCase();
  const semi = trimmed.indexOf(";");
  return (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
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

function isSupportedRasterMediaType(normalized: string): boolean {
  return (
    isJpegMediaType(normalized) ||
    isPngMediaType(normalized) ||
    normalized === "image/webp" ||
    normalized === "image/heic" ||
    normalized === "image/heif" ||
    normalized === "image/heic-sequence" ||
    normalized === "image/heif-sequence" ||
    normalized === "image/avif" ||
    normalized === "image/avif-sequence"
  );
}

function encodeJpegUnderBudget(
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
function encodeJpegMaxQualityUnderBudget(
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
    const mid = (lo + hi) >> 1;
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

function encodePngUnderBudget(
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

function needsWasmImageCodecs(
  mediaType: string,
  bytes: Uint8Array
): boolean {
  const normalized = baseMediaType(mediaType);
  return (
    normalized === "image/webp" ||
    normalized === "image/heic" ||
    normalized === "image/heif" ||
    normalized === "image/heic-sequence" ||
    normalized === "image/heif-sequence" ||
    normalized === "image/avif" ||
    normalized === "image/avif-sequence" ||
    looksLikeHeic(bytes) ||
    looksLikeAvif(bytes) ||
    looksLikeWebp(bytes)
  );
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
  const normalized = baseMediaType(mediaType);
  try {
    // Prefer container magic over declared MIME when both are present.
    if (looksLikeJpeg(bytes)) {
      return decodeJpegToRgba(bytes);
    }
    if (looksLikePng(bytes)) {
      return decodePngToRgba(bytes);
    }
    // AVIF before HEIC (shared ISO-BMFF + overlapping `mif1` brands).
    if (looksLikeAvif(bytes)) {
      return await decodeAvifToRgba(bytes);
    }
    if (looksLikeHeic(bytes)) {
      return await decodeHeicToRgba(bytes);
    }
    if (looksLikeWebp(bytes)) {
      return await decodeWebpToRgba(bytes);
    }

    // No recognized magic — fall back to declared type.
    if (isJpegMediaType(normalized)) {
      return decodeJpegToRgba(bytes);
    }
    if (isPngMediaType(normalized)) {
      return decodePngToRgba(bytes);
    }

    if (
      normalized === "image/heic" ||
      normalized === "image/heif" ||
      normalized === "image/heic-sequence" ||
      normalized === "image/heif-sequence"
    ) {
      return await decodeHeicToRgba(bytes);
    }
    if (normalized === "image/avif" || normalized === "image/avif-sequence") {
      return await decodeAvifToRgba(bytes);
    }
    if (normalized === "image/webp") {
      return await decodeWebpToRgba(bytes);
    }

    if (isSupportedRasterMediaType(normalized)) {
      throw new Error(
        `Bytes do not match a decodable ${normalized} payload (truncated or corrupt?).`
      );
    }

    throw new Error(
      `Unsupported image media type for normalization: ${normalized}. ` +
        `Supported: jpeg, png, webp, heic/heif, avif. (gif/bmp/svg/tiff are not decoded.)`
    );
  } catch (error) {
    if (error instanceof RuntimeAttachmentStagingError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeAttachmentStagingError(
      `Unable to decode image attachment for normalization (${normalized}): ${detail}`
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

/**
 * Edge-safe HEIC decode via libheif ESM bundle (wasmBinary inlined).
 * Avoids `heic-decode`'s CJS path that touches `__dirname` under Workers.
 */
async function decodeHeicToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  try {
    return await decodeHeicWithLibheifEsm(bytes);
  } catch (edgeError) {
    // Node fallback
    try {
      const decode = (await import("heic-decode")).default;
      const decoded = await decode({
        buffer: bytes as unknown as ArrayBuffer,
      });
      return {
        data: asUint8Array(decoded.data),
        height: decoded.height,
        width: decoded.width,
      };
    } catch {
      throw edgeError;
    }
  }
}

type LibheifImage = {
  display: (
    imageData: {
      data: Uint8ClampedArray;
      height: number;
      width: number;
    },
    callback: (
      displayData: { data: Uint8ClampedArray; height: number; width: number } | null
    ) => void
  ) => void;
  free: () => void;
  get_height: () => number;
  get_width: () => number;
};

type LibheifModule = {
  HeifDecoder: new () => {
    decode: (buffer: Uint8Array) => LibheifImage[];
    decoder: { delete: () => void };
  };
  ready: Promise<void>;
};

/** Cached libheif module — Wasm.Instance is expensive; reuse across HEIC decodes. */
let libheifModulePromise: Promise<LibheifModule> | undefined;
/**
 * Serialize HEIC decodes: a single libheif Wasm instance is not safe for
 * concurrent decode/display (Promise.all of HEIC attachments fails with
 * "HEIF processing error").
 */
let heicDecodeGate: Promise<void> = Promise.resolve();

async function getLibheifModule(): Promise<LibheifModule> {
  if (!libheifModulePromise) {
    libheifModulePromise = (async () => {
      // Workers + nodejs_compat: emscripten may probe Node and touch __dirname.
      polyfillEmscriptenNodeShims();
      await ensureImageCodecRuntimeReady();

      const heifWasm = getInstalledImageCodecWasm().heifDecodeWasm as
        | WebAssembly.Module
        | undefined;
      if (!heifWasm) {
        throw new Error(
          "HEIF decode wasm is not installed. On Cloudflare Workers, import image-codecs-edge (static libheif.wasm)."
        );
      }

      // ESM glue with instantiateWasm so Workers never compile wasm from raw bytes.
      const factory = (
        await import("libheif-js/libheif-wasm/libheif-bundle.mjs")
      ).default as (options?: object) => LibheifModule;

      const libheif =
        typeof factory === "function"
          ? factory({
              instantiateWasm(
                imports: WebAssembly.Imports,
                successCallback: (
                  instance: WebAssembly.Instance,
                  module: WebAssembly.Module
                ) => void
              ) {
                const instance = new WebAssembly.Instance(heifWasm, imports);
                successCallback(instance, heifWasm);
                return instance.exports;
              },
            })
          : factory;

      if (libheif.ready) {
        await libheif.ready;
      }
      return libheif;
    })();
  }
  try {
    return await libheifModulePromise;
  } catch (error) {
    // Allow retry after a failed cold init (e.g. missing wasm in tests).
    libheifModulePromise = undefined;
    throw error;
  }
}

async function decodeHeicWithLibheifEsm(bytes: Uint8Array): Promise<RgbaImage> {
  const previous = heicDecodeGate;
  let release!: () => void;
  heicDecodeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await decodeHeicWithLibheifEsmUnlocked(bytes);
  } finally {
    release();
  }
}

async function decodeHeicWithLibheifEsmUnlocked(
  bytes: Uint8Array
): Promise<RgbaImage> {
  const libheif = await getLibheifModule();
  const decoder = new libheif.HeifDecoder();
  let images: LibheifImage[] = [];
  try {
    images = decoder.decode(bytes);
    if (!images.length) {
      throw new Error("HEIF image not found");
    }
    const image = images[0];
    if (!image) {
      throw new Error("HEIF image not found");
    }
    const width = image.get_width();
    const height = image.get_height();
    const displayData = await new Promise<{
      data: Uint8ClampedArray;
      height: number;
      width: number;
    }>((resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (result) => {
          if (!result) {
            reject(new Error("HEIF processing error"));
            return;
          }
          resolve(result);
        }
      );
    });
    return {
      data: asUint8Array(displayData.data),
      height: displayData.height,
      width: displayData.width,
    };
  } finally {
    for (const image of images) {
      try {
        image.free();
      } catch {
        // ignore
      }
    }
    try {
      decoder.decoder.delete();
    } catch {
      // ignore
    }
  }
}

let avifInitPromise: Promise<void> | undefined;
let webpInitPromise: Promise<void> | undefined;
let runtimeReadyPromise: Promise<void> | undefined;

/** True when AVIF + WebP + HEIF decode wasm modules are installed. */
function hasAllImageDecodeWasm(): boolean {
  return (
    hasAvifDecodeWasm() && hasWebpDecodeWasm() && hasHeifDecodeWasm()
  );
}

/**
 * Load codec wasm for the current runtime.
 * 1) Already installed (Worker static imports / app bootstrap)
 * 2) Node: read wasm from node_modules
 * 3) Edge bundle: dynamic-import image-codecs-edge (static wasm imports inside)
 *
 * Never relies on bare jSquash `init()` network fetch — that breaks on Workers.
 * Never compiles wasm from raw bytes on Workers (embedder forbids it).
 */
async function ensureImageCodecRuntimeReady(): Promise<void> {
  if (runtimeReadyPromise) {
    await runtimeReadyPromise;
    return;
  }
  runtimeReadyPromise = (async () => {
    if (hasAllImageDecodeWasm()) {
      return;
    }
    await installImageCodecWasmFromNodeModules();
    if (hasAllImageDecodeWasm()) {
      return;
    }
    try {
      // Wrangler follows this static specifier and bundles .wasm imports.
      const edge = await import("../../platform/cloudflare/image-codecs-edge.js");
      edge.installCloudflareImageCodecs();
    } catch {
      // Not bundled (e.g. pure Node unit path without edge entry).
    }
  })();
  await runtimeReadyPromise;
}

async function ensureAvifDecoderInitialized(): Promise<void> {
  if (!avifInitPromise) {
    avifInitPromise = (async () => {
      await ensureImageCodecRuntimeReady();
      const wasm = getInstalledImageCodecWasm().avifDecodeWasm;
      if (!wasm) {
        throw new Error(
          "AVIF decode wasm is not installed. On Cloudflare Workers, import @minpeter/pss-runtime/platform/cloudflare (image-codecs-edge) or call installImageCodecWasm()."
        );
      }
      const mod = await import("@jsquash/avif/decode.js");
      await mod.init(wasm as WebAssembly.Module);
    })();
  }
  await avifInitPromise;
}

async function ensureWebpDecoderInitialized(): Promise<void> {
  if (!webpInitPromise) {
    webpInitPromise = (async () => {
      await ensureImageCodecRuntimeReady();
      const wasm = getInstalledImageCodecWasm().webpDecodeWasm;
      if (!wasm) {
        throw new Error(
          "WebP decode wasm is not installed. On Cloudflare Workers, import @minpeter/pss-runtime/platform/cloudflare (image-codecs-edge) or call installImageCodecWasm()."
        );
      }
      const mod = await import("@jsquash/webp/decode.js");
      await mod.init(wasm as WebAssembly.Module);
    })();
  }
  await webpInitPromise;
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
  // AVIF before HEIC: both are ISO-BMFF; many AVIFs also list `mif1`.
  if (looksLikeAvif(bytes)) {
    return "image/avif";
  }
  if (looksLikeHeic(bytes)) {
    return "image/heic";
  }
  if (looksLikeWebp(bytes)) {
    return "image/webp";
  }
  return;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** JPEG SOI + EOI — truncated streams must not passthrough. */
function looksLikeCompleteJpeg(bytes: Uint8Array): boolean {
  return (
    looksLikeJpeg(bytes) &&
    bytes.length >= 4 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
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

/** PNG signature + IEND chunk near end — truncated streams must not passthrough. */
function looksLikeCompletePng(bytes: Uint8Array): boolean {
  if (!looksLikePng(bytes) || bytes.length < 12) {
    return false;
  }
  const start = Math.max(8, bytes.length - 24);
  for (let i = start; i <= bytes.length - 4; i += 1) {
    if (
      bytes[i] === 0x49 &&
      bytes[i + 1] === 0x45 &&
      bytes[i + 2] === 0x4e &&
      bytes[i + 3] === 0x44
    ) {
      return true;
    }
  }
  return false;
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
  // Prefer AVIF when both brand families appear (common with `mif1` + `avif`).
  return isIsoBmffBrand(bytes, HEIC_BRANDS) && !isIsoBmffBrand(bytes, AVIF_BRANDS);
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

  // Major brand at offset 8, then compatible brands from offset 16.
  const major = fourCc(bytes, 8);
  if (brands.has(major)) {
    return true;
  }
  for (let offset = 16; offset + 4 <= bytes.length && offset < 64; offset += 4) {
    if (brands.has(fourCc(bytes, offset))) {
      return true;
    }
  }
  return false;
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  )
    .replaceAll("\0", " ")
    .trim();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/**
 * Emscripten Node probes under Cloudflare Workers + nodejs_compat hit missing
 * `__dirname` / `__filename`. Provide minimal shims so inlined-wasm bundles boot.
 */
function polyfillEmscriptenNodeShims(): void {
  const g = globalThis as typeof globalThis & {
    __dirname?: string;
    __filename?: string;
  };
  if (typeof g.__dirname !== "string") {
    g.__dirname = "/";
  }
  if (typeof g.__filename !== "string") {
    g.__filename = "/libheif.js";
  }
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
