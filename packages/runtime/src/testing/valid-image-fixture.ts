import { encode as encodePng } from "fast-png";

/**
 * Valid opaque PNG for tests that need real image bytes (attachment normalize
 * rejects synthetic non-PNG payloads labeled image/png).
 */
export function solidTestPng(size = 8): Uint8Array {
  const edge = Math.max(1, size);
  const data = new Uint8Array(edge * edge * 4);
  data.fill(255);
  return encodePng({
    width: edge,
    height: edge,
    data,
    channels: 4,
    depth: 8,
  });
}

export function solidTestPngBase64(size = 8): string {
  return Buffer.from(solidTestPng(size)).toString("base64");
}
