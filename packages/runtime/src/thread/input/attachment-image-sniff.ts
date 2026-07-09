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

export function baseMediaType(mediaType: string): string {
  const trimmed = mediaType.trim().toLowerCase();
  const semi = trimmed.indexOf(";");
  return (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
}

export function isImageMediaType(normalized: string): boolean {
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

export function isJpegMediaType(normalized: string): boolean {
  return normalized === "image/jpeg" || normalized === "image/jpg";
}

export function isPngMediaType(normalized: string): boolean {
  return normalized === "image/png" || normalized === "image/x-png";
}

export function isSupportedRasterMediaType(normalized: string): boolean {
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

export function needsWasmImageCodecs(
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

export function looksLikeKnownImage(bytes: Uint8Array): boolean {
  return (
    looksLikeJpeg(bytes) ||
    looksLikePng(bytes) ||
    looksLikeHeic(bytes) ||
    looksLikeAvif(bytes) ||
    looksLikeWebp(bytes)
  );
}

export function looksLikeOtherRaster(bytes: Uint8Array): boolean {
  return (
    looksLikePng(bytes) ||
    looksLikeHeic(bytes) ||
    looksLikeAvif(bytes) ||
    looksLikeWebp(bytes)
  );
}

export function sniffImageMediaType(bytes: Uint8Array): string | undefined {
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

export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** JPEG SOI + EOI — truncated streams must not passthrough. */
export function looksLikeCompleteJpeg(bytes: Uint8Array): boolean {
  return (
    looksLikeJpeg(bytes) &&
    bytes.length >= 4 &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

export function looksLikePng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

/** PNG signature + IEND chunk near end — truncated streams must not passthrough. */
export function looksLikeCompletePng(bytes: Uint8Array): boolean {
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

export function looksLikeWebp(bytes: Uint8Array): boolean {
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

export function looksLikeHeic(bytes: Uint8Array): boolean {
  // Prefer AVIF when both brand families appear (common with `mif1` + `avif`).
  return (
    isIsoBmffBrand(bytes, HEIC_BRANDS) && !isIsoBmffBrand(bytes, AVIF_BRANDS)
  );
}

export function looksLikeAvif(bytes: Uint8Array): boolean {
  return isIsoBmffBrand(bytes, AVIF_BRANDS);
}

export function isIsoBmffBrand(
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
  for (
    let offset = 16;
    offset + 4 <= bytes.length && offset < 64;
    offset += 4
  ) {
    if (brands.has(fourCc(bytes, offset))) {
      return true;
    }
  }
  return false;
}

export function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  )
    .replaceAll("\0", " ")
    .trim();
}
