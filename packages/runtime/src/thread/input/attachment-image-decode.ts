import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import {
  getInstalledImageCodecWasm,
  hasAvifDecodeWasm,
  hasHeifDecodeWasm,
  hasWebpDecodeWasm,
  installImageCodecWasmFromNodeModules,
} from "./attachment-image-codec-registry";
import {
  asUint8Array,
  type RgbaImage,
  toArrayBuffer,
} from "./attachment-image-rgba";
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
export async function ensureImageCodecRuntimeReady(): Promise<void> {
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

