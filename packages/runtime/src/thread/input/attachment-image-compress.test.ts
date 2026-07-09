import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "../../platform/memory";
import {
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  prepareAttachmentBytesForStorage,
} from "./attachment-image-compress";
import { decodeRuntimeAttachmentData } from "./attachment-refs";
import { stageUserInputAttachments } from "./attachment-staging";
import { RuntimeAttachmentStagingError } from "./attachment-types";

describe("prepareAttachmentBytesForStorage", () => {
  it("leaves non-image bytes unchanged even when larger than the default cap", () => {
    const bytes = new Uint8Array(DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES + 50_000);
    bytes.fill(7);
    const prepared = prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "application/pdf",
    });
    expect(prepared.bytes).toBe(bytes);
    expect(prepared.mediaType).toBe("application/pdf");
    expect(prepared.bytes.byteLength).toBeGreaterThan(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
  });

  it("leaves already-small images unchanged", () => {
    const bytes = encodeSolidJpeg(64, 64, 80);
    expect(bytes.byteLength).toBeLessThan(DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES);
    const prepared = prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg",
    });
    expect(prepared.bytes).toBe(bytes);
    expect(prepared.mediaType).toBe("image/jpeg");
  });

  it(
    "compresses oversized JPEGs under the default 1MB cap as image/jpeg",
    () => {
      const bytes = encodeNoisyJpeg(1600, 1600, 95);
      expect(bytes.byteLength).toBeGreaterThan(
        DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
      );

      const prepared = prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/jpeg",
      });

      expect(prepared.mediaType).toBe("image/jpeg");
      expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
        DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
      );
      expect(prepared.bytes.byteLength).toBeGreaterThan(0);
      // Still a decodable JPEG.
      const decoded = jpeg.decode(prepared.bytes, { useTArray: true });
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
    },
    20_000
  );

  it("compresses oversized PNGs under a custom maxImageBytes budget", () => {
    const bytes = encodeSolidPng(1800, 1800);
    // Solid PNGs can be small; force path with a tight budget.
    const maxImageBytes = Math.max(8_000, Math.floor(bytes.byteLength / 4));
    const prepared = prepareAttachmentBytesForStorage({
      bytes,
      maxImageBytes,
      mediaType: "image/png",
    });
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(maxImageBytes);
    expect(prepared.mediaType).toBe("image/jpeg");
  });

  it("throws when maxImageBytes is non-positive", () => {
    expect(() =>
      prepareAttachmentBytesForStorage({
        bytes: encodeSolidJpeg(32, 32, 80),
        maxImageBytes: 0,
        mediaType: "image/jpeg",
      })
    ).toThrow(RuntimeAttachmentStagingError);
  });
});

describe("stageUserInputAttachments image compression", () => {
  it(
    "stores compressed image bytes under the default 1MB cap",
    async () => {
      const store = new MemoryAttachmentStore();
      const large = encodeNoisyJpeg(1600, 1600, 95);
      expect(large.byteLength).toBeGreaterThan(
        DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
      );

      const staged = await stageUserInputAttachments(
        {
          type: "user-input",
          content: [
            {
              type: "file",
              mediaType: "image/jpeg",
              filename: "photo.jpg",
              data: large,
            },
          ],
        },
        store
      );

      if (!("content" in staged)) {
        throw new Error("expected multipart user input");
      }
      const part = staged.content[0];
      expect(part?.type).toBe("file");
      if (part?.type !== "file" || typeof part.data !== "string") {
        throw new Error("expected staged runtime attachment ref string");
      }
      const ref = decodeRuntimeAttachmentData(part.data);
      const blob = await store.get(ref);
      expect(blob).not.toBeNull();
      expect(blob?.mediaType).toBe("image/jpeg");
      expect(blob?.bytes.byteLength).toBeLessThanOrEqual(
        DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
      );
    },
    20_000
  );
});

function encodeSolidJpeg(
  width: number,
  height: number,
  quality: number
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 40;
    data[i + 1] = 80;
    data[i + 2] = 160;
    data[i + 3] = 255;
  }
  return asBytes(jpeg.encode({ data, width, height }, quality).data);
}

function encodeNoisyJpeg(
  width: number,
  height: number,
  quality: number
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 17) % 256;
    data[i + 1] = (i * 31) % 256;
    data[i + 2] = (i * 47) % 256;
    data[i + 3] = 255;
  }
  return asBytes(jpeg.encode({ data, width, height }, quality).data);
}

function encodeSolidPng(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 40;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  return encodePng({
    width,
    height,
    data,
    channels: 4,
    depth: 8,
  });
}

function asBytes(value: ArrayBuffer | Buffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
