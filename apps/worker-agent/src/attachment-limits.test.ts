import { describe, expect, it } from "vitest";

import {
  AGENT_MAX_BASE64_CHARS_PER_IMAGE,
  AGENT_MAX_RAW_IMAGE_BYTES,
  AGENT_MAX_TURN_BASE64_CHARS,
  AGENT_MAX_TURN_RAW_IMAGE_BYTES,
  base64CharLengthForBytes,
} from "./attachment-limits";

function realBase64Length(byteLength: number): number {
  if (byteLength === 0) {
    return 0;
  }
  const bytes = new Uint8Array(byteLength);
  let binary = "";
  for (let i = 0; i < byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).length;
}

describe("base64CharLengthForBytes", () => {
  it("matches real btoa length including padding for residue classes", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1000]) {
      expect(base64CharLengthForBytes(n)).toBe(realBase64Length(n));
    }
  });

  it("sizes caps so max raw images never exceed zod max base64 length", () => {
    expect(AGENT_MAX_BASE64_CHARS_PER_IMAGE).toBe(
      base64CharLengthForBytes(AGENT_MAX_RAW_IMAGE_BYTES)
    );
    expect(AGENT_MAX_TURN_BASE64_CHARS).toBe(
      base64CharLengthForBytes(AGENT_MAX_TURN_RAW_IMAGE_BYTES)
    );
    // ceil(4n/3) under-counts 2_000_000 by 1 vs real padded base64.
    expect(AGENT_MAX_BASE64_CHARS_PER_IMAGE).toBeGreaterThan(
      Math.ceil((AGENT_MAX_RAW_IMAGE_BYTES * 4) / 3)
    );
    expect(
      base64CharLengthForBytes(AGENT_MAX_RAW_IMAGE_BYTES)
    ).toBeLessThanOrEqual(AGENT_MAX_BASE64_CHARS_PER_IMAGE);
  });
});
