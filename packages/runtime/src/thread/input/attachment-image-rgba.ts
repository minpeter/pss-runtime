/** Shared RGBA frame type and pixel helpers for image normalize. */

export interface RgbaImage {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

export function asUint8Array(
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

export function rgbaHasTransparency(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 255) {
      return true;
    }
  }
  return false;
}

export function flattenAlphaOntoWhite(image: RgbaImage): RgbaImage {
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

export function scaleRgbaNearest(
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

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}
