import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "../../platform/memory";
import {
  assertDecodedImageWithinLimits,
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  isStoredImageMediaType,
  MAX_IMAGE_DECODED_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
  prepareAttachmentBytesForStorage,
  runWithImagePrepareDiagnosticsListener,
} from "./attachment-image-compress";
import { decodeRuntimeAttachmentData } from "./attachment-refs";
import { stageUserInputAttachments } from "./attachment-staging-input";
import { RuntimeAttachmentStagingError } from "./attachment-types";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const MAX_INPUT_SIZE_ERROR = /max input size/i;
const MAX_DECODED_PIXELS_ERROR = /max decoded pixel count/i;
const UNSUPPORTED_GIF_ERROR = /Unsupported image media type|gif/i;
const UNSUPPORTED_SVG_ERROR = /Unsupported image media type|svg/i;

describe("prepareAttachmentBytesForStorage", () => {
  it("leaves non-image bytes unchanged even when larger than the default cap", async () => {
    const bytes = new Uint8Array(DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES + 50_000);
    bytes.fill(7);
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "application/pdf",
    });
    expect(prepared.bytes).toBe(bytes);
    expect(prepared.mediaType).toBe("application/pdf");
  });

  it("passthroughs small JPEG bytes as image/jpeg", async () => {
    const bytes = encodeSolidJpeg(64, 64, 80);
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg",
    });
    expect(prepared.bytes).toBe(bytes);
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(isStoredImageMediaType(prepared.mediaType)).toBe(true);
    expect(prepared.diagnostics).toMatchObject({
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      outputMediaType: "image/jpeg",
      path: "passthrough_jpeg",
    });
  });

  it("delivers diagnostics to ALS listener without dual tree when collected", async () => {
    const bytes = encodeSolidJpeg(64, 64, 80);
    const received: string[] = [];
    await runWithImagePrepareDiagnosticsListener(
      (diagnostics) => {
        received.push(diagnostics.path);
      },
      async () => {
        await prepareAttachmentBytesForStorage({
          bytes,
          mediaType: "image/jpeg",
        });
      }
    );
    expect(received).toEqual(["passthrough_jpeg"]);
  });

  it("delivers diagnostics via onImagePrepare staging option", async () => {
    const bytes = encodeSolidJpeg(64, 64, 80);
    const received: string[] = [];
    await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg",
      onImagePrepare: (diagnostics) => {
        received.push(diagnostics.path);
      },
    });
    expect(received).toEqual(["passthrough_jpeg"]);
  });

  it("passthroughs small PNG bytes as image/png", async () => {
    const bytes = encodeSolidPng(32, 32, false);
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/png",
    });
    expect(prepared.bytes).toBe(bytes);
    expect(prepared.mediaType).toBe("image/png");
    expect(prepared.diagnostics?.path).toBe("passthrough_png");
  });

  it("compresses oversized opaque images to image/jpeg under the default budget", async () => {
    const bytes = encodeNoisyJpeg(1600, 1600, 95);
    expect(bytes.byteLength).toBeGreaterThan(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
    expect(prepared.diagnostics).toMatchObject({
      inputBytes: bytes.byteLength,
      path: "reencode_jpeg",
    });
    expect(prepared.diagnostics?.outputBytes).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
    expect(
      jpeg.decode(prepared.bytes, { useTArray: true }).width
    ).toBeGreaterThan(0);
  }, 20_000);

  it("keeps transparent PNGs as image/png when under budget", async () => {
    const bytes = encodeSolidPng(64, 64, true);
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/png",
    });
    expect(prepared.mediaType).toBe("image/png");
    expect(prepared.bytes).toBe(bytes);
  });

  it("encodes transparent oversized frames as PNG (or JPEG fallback)", async () => {
    const bytes = encodeSolidPng(1800, 1800, true);
    const maxImageBytes = 50_000;
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      maxImageBytes,
      mediaType: "image/png",
    });
    expect(isStoredImageMediaType(prepared.mediaType)).toBe(true);
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(maxImageBytes);
    // Solid frames may already be under budget (passthrough); reencode paths
    // must match output media type (including PNG→JPEG fallback labeling).
    if (prepared.diagnostics?.path === "passthrough_png") {
      expect(prepared.mediaType).toBe("image/png");
    } else if (prepared.mediaType === "image/jpeg") {
      expect(prepared.diagnostics?.path).toBe("reencode_png_fallback_jpeg");
    } else {
      expect(prepared.diagnostics?.path).toBe("reencode_png");
    }
  }, 20_000);

  it("always normalizes HEIC to image/jpeg or image/png (never heic)", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample.heic"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/heic",
    });
    expect(isStoredImageMediaType(prepared.mediaType)).toBe(true);
    expect(prepared.mediaType).not.toBe("image/heic");
    // fixture is photo-like / opaque → jpeg
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
  }, 30_000);

  it("always normalizes AVIF to image/jpeg or image/png (never avif)", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample.avif"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/avif",
    });
    expect(isStoredImageMediaType(prepared.mediaType)).toBe(true);
    expect(prepared.mediaType).not.toBe("image/avif");
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
  }, 30_000);

  it("always normalizes WebP to image/jpeg or image/png (never webp)", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample.webp"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/webp",
    });
    expect(isStoredImageMediaType(prepared.mediaType)).toBe(true);
    expect(prepared.mediaType).not.toBe("image/webp");
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
  }, 30_000);

  it("throws when maxImageBytes is non-positive", async () => {
    await expect(
      prepareAttachmentBytesForStorage({
        bytes: encodeSolidJpeg(32, 32, 80),
        maxImageBytes: 0,
        mediaType: "image/jpeg",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("throws when maxImageBytes exceeds storage budget ceiling", async () => {
    await expect(
      prepareAttachmentBytesForStorage({
        bytes: encodeSolidJpeg(32, 32, 80),
        maxImageBytes: 50_000_001,
        mediaType: "image/jpeg",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("rejects oversized raw image inputs before decode", async () => {
    const bytes = new Uint8Array(MAX_IMAGE_INPUT_BYTES + 1);
    // Minimal JPEG SOI so it is treated as an image without full decode passthrough.
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[bytes.length - 2] = 0xff;
    bytes[bytes.length - 1] = 0xd9;
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/jpeg",
      })
    ).rejects.toThrow(MAX_INPUT_SIZE_ERROR);
  });

  it("rejects decoded frames above MAX_IMAGE_DECODED_PIXELS", () => {
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_DECODED_PIXELS)) + 1;
    expect(() =>
      assertDecodedImageWithinLimits({ width: side, height: side })
    ).toThrow(MAX_DECODED_PIXELS_ERROR);
    expect(() =>
      assertDecodedImageWithinLimits({ width: 100, height: 100 })
    ).not.toThrow();
  });

  it("strips MIME parameters for JPEG passthrough", async () => {
    const bytes = encodeSolidJpeg(32, 32, 80);
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg; charset=binary",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes).toBe(bytes);
  });

  it("strips MIME parameters for HEIC", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample.heic"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/heic; codecs=hevc",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
  }, 30_000);

  it("rejects unsupported GIF with a clear error", async () => {
    // Minimal GIF89a header-ish bytes (not a full image; no decoder path).
    const bytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x3b,
    ]);
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/gif",
      })
    ).rejects.toThrow(UNSUPPORTED_GIF_ERROR);
  });

  it("rejects SVG as unsupported for raster normalization", async () => {
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    );
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/svg+xml",
      })
    ).rejects.toThrow(UNSUPPORTED_SVG_ERROR);
  });

  it("sniffs JPEG bytes even when mediaType is image/png", async () => {
    const bytes = encodeSolidJpeg(24, 24, 80);
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/png",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
  });

  it("sniffs HEIC bytes even when mediaType lies (image/jpeg)", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample.heic"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
    expect(prepared.bytes[0]).toBe(0xff);
    expect(prepared.bytes[1]).toBe(0xd8);
  }, 30_000);

  it("sniffs HEIC under application/octet-stream", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample.heic"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "application/octet-stream",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
  }, 30_000);

  it("normalizes alpha WebP to image/png (never webp)", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "sample-alpha.webp"))
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/webp",
    });
    expect(prepared.mediaType).toBe("image/png");
    expect(prepared.bytes[0]).toBe(0x89);
    expect(prepared.bytes[1]).toBe(0x50);
  }, 30_000);

  it("rejects truncated JPEG (no EOI passthrough)", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "corrupt-truncated.jpeg"))
    );
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/jpeg",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("rejects truncated HEIC", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "corrupt-truncated.heic"))
    );
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/heic",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("rejects garbage WebP", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "corrupt-garbage.webp"))
    );
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/webp",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("rejects truncated AVIF", async () => {
    const bytes = new Uint8Array(
      readFileSync(join(fixturesDir, "corrupt-truncated.avif"))
    );
    await expect(
      prepareAttachmentBytesForStorage({
        bytes,
        mediaType: "image/avif",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("rejects empty image/* payload", async () => {
    await expect(
      prepareAttachmentBytesForStorage({
        bytes: new Uint8Array(0),
        mediaType: "image/png",
      })
    ).rejects.toBeInstanceOf(RuntimeAttachmentStagingError);
  });

  it("compresses extreme-resolution JPEG under the default budget", async () => {
    const bytes = encodeNoisyJpeg(2200, 2200, 90);
    expect(bytes.byteLength).toBeGreaterThan(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      mediaType: "image/jpeg",
    });
    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
    );
  }, 30_000);

  it("handles concurrent multi-format normalization", async () => {
    const heic = new Uint8Array(readFileSync(join(fixturesDir, "sample.heic")));
    const avif = new Uint8Array(readFileSync(join(fixturesDir, "sample.avif")));
    const webp = new Uint8Array(readFileSync(join(fixturesDir, "sample.webp")));
    const alpha = new Uint8Array(
      readFileSync(join(fixturesDir, "sample-alpha.webp"))
    );
    const results = await Promise.all([
      prepareAttachmentBytesForStorage({
        bytes: heic,
        mediaType: "image/heic",
      }),
      prepareAttachmentBytesForStorage({
        bytes: avif,
        mediaType: "image/avif",
      }),
      prepareAttachmentBytesForStorage({
        bytes: webp,
        mediaType: "image/webp",
      }),
      prepareAttachmentBytesForStorage({
        bytes: alpha,
        mediaType: "image/webp",
      }),
    ]);
    expect(results.map((r) => r.mediaType)).toEqual([
      "image/jpeg",
      "image/jpeg",
      "image/jpeg",
      "image/png",
    ]);
    for (const r of results) {
      expect(r.bytes.byteLength).toBeLessThanOrEqual(
        DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES
      );
    }
  }, 60_000);
});

describe("stageUserInputAttachments image normalization", () => {
  it("soft-omits images that exceed safety input limits without failing the turn", async () => {
    const store = new MemoryAttachmentStore();
    const huge = new Uint8Array(MAX_IMAGE_INPUT_BYTES + 1);
    huge[0] = 0xff;
    huge[1] = 0xd8;
    huge[huge.length - 2] = 0xff;
    huge[huge.length - 1] = 0xd9;

    const staged = await stageUserInputAttachments(
      {
        type: "user-input",
        content: [
          { type: "text", text: "see this?" },
          {
            type: "file",
            mediaType: "image/jpeg",
            filename: "huge.jpg",
            data: huge,
          },
        ],
      },
      store
    );

    if (!("content" in staged)) {
      throw new Error("expected multipart user input");
    }
    expect(staged.content).toHaveLength(2);
    expect(staged.content[0]).toEqual({ type: "text", text: "see this?" });
    expect(staged.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Attachment omitted: huge.jpg"),
    });
  });

  it("stores only jpeg/png media types for image inputs", async () => {
    const store = new MemoryAttachmentStore();
    const heic = new Uint8Array(readFileSync(join(fixturesDir, "sample.heic")));

    const staged = await stageUserInputAttachments(
      {
        type: "user-input",
        content: [
          {
            type: "file",
            mediaType: "image/heic",
            filename: "photo.heic",
            data: heic,
          },
        ],
      },
      store
    );

    if (!("content" in staged)) {
      throw new Error("expected multipart user input");
    }
    const part = staged.content[0];
    if (part?.type !== "file" || typeof part.data !== "string") {
      throw new Error("expected staged runtime attachment ref string");
    }
    const ref = decodeRuntimeAttachmentData(part.data);
    const blob = await store.get(ref);
    expect(blob).not.toBeNull();
    expect(isStoredImageMediaType(blob?.mediaType ?? "")).toBe(true);
    expect(blob?.mediaType).toBe("image/jpeg");
  }, 30_000);

  it("stages multi-image user input (heic+avif+webp+alpha) to jpeg/png only", async () => {
    const store = new MemoryAttachmentStore();
    const staged = await stageUserInputAttachments(
      {
        type: "user-input",
        content: [
          {
            type: "file",
            mediaType: "image/heic",
            filename: "a.heic",
            data: new Uint8Array(
              readFileSync(join(fixturesDir, "sample.heic"))
            ),
          },
          {
            type: "file",
            mediaType: "image/avif",
            filename: "b.avif",
            data: new Uint8Array(
              readFileSync(join(fixturesDir, "sample.avif"))
            ),
          },
          {
            type: "file",
            mediaType: "image/webp",
            filename: "c.webp",
            data: new Uint8Array(
              readFileSync(join(fixturesDir, "sample.webp"))
            ),
          },
          {
            type: "file",
            mediaType: "image/webp",
            filename: "d-alpha.webp",
            data: new Uint8Array(
              readFileSync(join(fixturesDir, "sample-alpha.webp"))
            ),
          },
        ],
      },
      store
    );

    if (!("content" in staged)) {
      throw new Error("expected multipart user input");
    }
    expect(staged.content).toHaveLength(4);
    const storedTypes: string[] = [];
    for (const part of staged.content) {
      if (part?.type !== "file" || typeof part.data !== "string") {
        throw new Error("expected staged ref");
      }
      const blob = await store.get(decodeRuntimeAttachmentData(part.data));
      expect(blob).not.toBeNull();
      expect(isStoredImageMediaType(blob?.mediaType ?? "")).toBe(true);
      expect(
        blob?.bytes.byteLength ?? Number.POSITIVE_INFINITY
      ).toBeLessThanOrEqual(DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES);
      storedTypes.push(blob?.mediaType ?? "");
    }
    expect(storedTypes).toEqual([
      "image/jpeg",
      "image/jpeg",
      "image/jpeg",
      "image/png",
    ]);
  }, 60_000);
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

function encodeSolidPng(
  width: number,
  height: number,
  transparent: boolean
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 40;
    data[i + 2] = 40;
    data[i + 3] = transparent ? 128 : 255;
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
