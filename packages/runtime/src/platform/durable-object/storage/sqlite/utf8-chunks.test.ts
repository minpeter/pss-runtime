import { describe, expect, it } from "vitest";
import { chunkSerializedPayload } from "./utf8-chunks";

const encoder = new TextEncoder();
const isHighSurrogate = (code: number) => code >= 0xd8_00 && code <= 0xdb_ff;
const isLowSurrogate = (code: number) => code >= 0xdc_00 && code <= 0xdf_ff;

describe("chunkSerializedPayload", () => {
  it.each([
    "\u{1F600}",
    "a\u{1F600}",
    "output \u{1F600} ",
    "\u00E9\u{1F600}\u00FC",
  ])("bounds %j chunks without splitting surrogate pairs", (unit) => {
    for (let repeat = 1; repeat <= 12; repeat += 1) {
      const serialized = JSON.stringify({ text: unit.repeat(repeat) });
      for (let maxBytes = 1; maxBytes <= 48; maxBytes += 1) {
        const chunks = chunkSerializedPayload(serialized, maxBytes);
        expect(chunks.join("")).toBe(serialized);
        for (const chunk of chunks) {
          expect(isHighSurrogate(chunk.charCodeAt(chunk.length - 1))).toBe(
            false
          );
          expect(isLowSurrogate(chunk.charCodeAt(0))).toBe(false);
          if ([...chunk].length > 1) {
            expect(encoder.encode(chunk).byteLength).toBeLessThanOrEqual(
              maxBytes
            );
          }
        }
      }
    }
  });
});
