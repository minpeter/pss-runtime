import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import { asUint8Array, type RgbaImage } from "./attachment-image-rgba";
import { decodeHeicToRgba } from "./attachment-image-decode-heic";
import {
  decodeAvifToRgba,
  decodeWebpToRgba,
  ensureImageCodecRuntimeReady,
} from "./attachment-image-decode-runtime";
import {
  baseMediaType,
  isJpegMediaType,
  isPngMediaType,
  isSupportedRasterMediaType,
  looksLikeAvif,
  looksLikeHeic,
  looksLikeJpeg,
  looksLikePng,
  looksLikeWebp,
} from "./attachment-image-sniff";
import { RuntimeAttachmentStagingError } from "./attachment-types";

export { ensureImageCodecRuntimeReady } from "./attachment-image-decode-runtime";

export async function decodeImageRgba(
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

