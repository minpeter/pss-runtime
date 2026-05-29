import type { UserMessageImagePart } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type ClipboardImageReader,
  type ClipboardImageReadResult,
  createClipboardImageReader,
  readClipboardImagePart,
} from "./clipboard-image";

const fakePngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const fakeJpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]);
const dataUri = (mediaType: string, bytes: Uint8Array) =>
  `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;

describe("ClipboardImageReader", () => {
  it("converts fake PNG bytes into a runtime image part", async () => {
    const reader = fakeReader({
      image: fakePngBytes,
      mediaType: "image/png",
      type: "image",
    });

    const result = await readClipboardImagePart({ reader });

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      image: dataUri("image/png", fakePngBytes),
      mediaType: "image/png",
      type: "image",
    } satisfies UserMessageImagePart);
  });

  it("converts fake JPEG bytes into a runtime image part", async () => {
    const reader = fakeReader({
      image: fakeJpegBytes,
      mediaType: "image/jpeg",
      type: "image",
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      image: dataUri("image/jpeg", fakeJpegBytes),
      mediaType: "image/jpeg",
      type: "image",
    } satisfies UserMessageImagePart);
  });

  it("reports an empty clipboard as a nonfatal no-image result", async () => {
    const reader = fakeReader({
      reason: "clipboard_image_not_found",
      type: "no-image",
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      message: "Clipboard does not contain a PNG or JPEG image.",
      reason: "clipboard_image_not_found",
      type: "no-image",
    });
  });

  it("reports unsupported or headless environments without throwing", async () => {
    const reader = fakeReader({
      message: "No supported clipboard image reader is available.",
      reason: "clipboard_image_unsupported_platform",
      type: "error",
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      message: "No supported clipboard image reader is available.",
      reason: "clipboard_image_unsupported_platform",
      type: "error",
    });
  });

  it("rejects unsupported clipboard media types before creating a data URI", async () => {
    const reader = fakeReader({
      image: Uint8Array.from([0x47, 0x49, 0x46]),
      mediaType: "image/gif",
      type: "image",
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      mediaType: "image/gif",
      message: "Clipboard image media type image/gif is not supported.",
      reason: "clipboard_image_unsupported_media_type",
      type: "error",
    });
  });

  it("rejects images over the default 10 MiB limit", async () => {
    const reader = fakeReader({
      byteLength: 10_485_761,
      image: new Uint8Array(10_485_761),
      mediaType: "image/png",
      type: "image",
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      byteLength: 10_485_761,
      maxByteLength: 10_485_760,
      message:
        "Clipboard image is 10485761 bytes, exceeding the 10485760 byte limit.",
      reason: "clipboard_image_too_large",
      type: "error",
    });
  });

  it("uses injected subprocess runners only in tests and never probes the real clipboard", async () => {
    const pngpasteOutput = Buffer.from(
      Buffer.from(fakePngBytes).toString("base64")
    );
    const run = vi.fn().mockResolvedValue({
      stdout: pngpasteOutput,
    });
    const reader = createClipboardImageReader({
      platform: "darwin",
      run,
    });

    const result = await readClipboardImagePart({ reader });

    expect(run).toHaveBeenCalledWith({
      args: ["-b"],
      command: "pngpaste",
      input: undefined,
      outputEncoding: "base64",
    });
    expect(result).toEqual({
      image: dataUri("image/png", fakePngBytes),
      mediaType: "image/png",
      type: "image",
    } satisfies UserMessageImagePart);
  });

  it("decodes macOS pngpaste base64 text into PNG bytes", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: `${Buffer.from(fakePngBytes).toString("base64")}\n`,
    });
    const reader = createClipboardImageReader({
      platform: "darwin",
      run,
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      image: dataUri("image/png", fakePngBytes),
      mediaType: "image/png",
      type: "image",
    } satisfies UserMessageImagePart);
  });

  it("selects wl-paste for Linux Wayland sessions", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(fakePngBytes),
    });
    const reader = createClipboardImageReader({
      env: { WAYLAND_DISPLAY: "wayland-1" },
      platform: "linux",
      run,
    });

    await readClipboardImagePart({ reader });

    expect(run).toHaveBeenCalledWith({
      args: ["--type", "image/png"],
      command: "wl-paste",
      input: undefined,
      mediaType: "image/png",
      outputEncoding: "bytes",
    });
  });

  it("selects xclip for Linux X11 sessions", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.from(fakePngBytes),
    });
    const reader = createClipboardImageReader({
      env: { DISPLAY: ":0" },
      platform: "linux",
      run,
    });

    await readClipboardImagePart({ reader });

    expect(run).toHaveBeenCalledWith({
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
      command: "xclip",
      input: undefined,
      mediaType: "image/png",
      outputEncoding: "bytes",
    });
  });

  it("reports headless Linux without running a command", async () => {
    const run = vi.fn();
    const reader = createClipboardImageReader({
      env: {},
      platform: "linux",
      run,
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      message:
        "No supported clipboard image reader is available. Set WAYLAND_DISPLAY or DISPLAY and install wl-paste or xclip.",
      reason: "clipboard_image_unsupported_platform",
      type: "error",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports missing clipboard commands without throwing", async () => {
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("missing"), {
        code: "ENOENT",
      })
    );
    const reader = createClipboardImageReader({
      platform: "darwin",
      run,
    });

    await expect(readClipboardImagePart({ reader })).resolves.toEqual({
      message:
        "Clipboard image reader command pngpaste was not found. Install it and try again.",
      reason: "clipboard_image_command_missing",
      type: "error",
    });
  });
});

function fakeReader(result: ClipboardImageReadResult): ClipboardImageReader {
  return {
    read: vi.fn().mockResolvedValue(result),
  };
}
