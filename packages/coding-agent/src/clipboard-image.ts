import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UserMessageImagePart } from "@minpeter/pss-runtime";

const execFileAsync = promisify(execFile);

export const DEFAULT_CLIPBOARD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type ClipboardImageMediaType = "image/jpeg" | "image/png";

export type ClipboardImageReadResult =
  | ClipboardImageErrorResult
  | ClipboardImageNoImageResult
  | ClipboardImageSuccessResult;

export interface ClipboardImageSuccessResult {
  readonly byteLength?: number;
  readonly image: Uint8Array;
  readonly mediaType: string;
  readonly type: "image";
}

export interface ClipboardImageNoImageResult {
  readonly message?: string;
  readonly reason: "clipboard_image_not_found";
  readonly type: "no-image";
}

export interface ClipboardImageErrorResult {
  readonly byteLength?: number;
  readonly maxByteLength?: number;
  readonly mediaType?: string;
  readonly message: string;
  readonly reason:
    | "clipboard_image_command_missing"
    | "clipboard_image_too_large"
    | "clipboard_image_unsupported_media_type"
    | "clipboard_image_unsupported_platform";
  readonly type: "error";
}

export interface ClipboardImageReader {
  read(): Promise<ClipboardImageReadResult>;
}

export interface ClipboardImageCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly input?: Uint8Array;
  readonly mediaType?: ClipboardImageMediaType;
  readonly outputEncoding?: "base64" | "bytes";
}

export interface ClipboardImageCommandResult {
  readonly stdout: Buffer | Uint8Array | string;
}

export type ClipboardImageCommandRunner = (
  command: ClipboardImageCommand
) => Promise<ClipboardImageCommandResult>;

export interface CreateClipboardImageReaderOptions {
  readonly env?: ClipboardImageEnv;
  readonly platform?: NodeJS.Platform | string;
  readonly run?: ClipboardImageCommandRunner;
  readonly runCommand?: ClipboardImageCommandRunner;
}

export interface ReadClipboardImagePartOptions {
  readonly maxByteLength?: number;
  readonly reader?: ClipboardImageReader;
}

type ClipboardImageEnv = Record<string, string | undefined>;

type ReadClipboardImagePartResult =
  | ClipboardImageErrorResult
  | ClipboardImageNoImageResult
  | UserMessageImagePart;

export async function readClipboardImagePart(
  options: ReadClipboardImagePartOptions = {}
): Promise<ReadClipboardImagePartResult> {
  const result = await (options.reader ?? createClipboardImageReader()).read();

  if (result.type !== "image") {
    return normalizeNonImageResult(result);
  }

  const mediaType = readSupportedMediaType(result.mediaType);

  if (!mediaType) {
    return {
      mediaType: result.mediaType,
      message: `Clipboard image media type ${result.mediaType} is not supported.`,
      reason: "clipboard_image_unsupported_media_type",
      type: "error",
    };
  }

  const byteLength = result.byteLength ?? result.image.byteLength;
  const maxByteLength =
    options.maxByteLength ?? DEFAULT_CLIPBOARD_IMAGE_MAX_BYTES;

  if (byteLength > maxByteLength) {
    return {
      byteLength,
      maxByteLength,
      message: `Clipboard image is ${byteLength} bytes, exceeding the ${maxByteLength} byte limit.`,
      reason: "clipboard_image_too_large",
      type: "error",
    };
  }

  return {
    image: `data:${mediaType};base64,${Buffer.from(result.image).toString(
      "base64"
    )}`,
    mediaType,
    type: "image",
  };
}

export function createClipboardImageReader(
  options: CreateClipboardImageReaderOptions = {}
): ClipboardImageReader {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const command = selectClipboardImageCommand(platform, env);
  const run = options.run ?? options.runCommand ?? runClipboardImageCommand;

  return {
    async read() {
      if (!command) {
        return unsupportedPlatformResult(platform);
      }

      try {
        const output = await run(command);
        const image = toUint8Array(
          output.stdout,
          command.outputEncoding ?? "bytes"
        );

        if (image.byteLength === 0) {
          return noImageResult();
        }

        const mediaType = detectImageMediaType(image) ?? command.mediaType;

        if (!mediaType) {
          return {
            mediaType: "application/octet-stream",
            message:
              "Clipboard image media type application/octet-stream is not supported.",
            reason: "clipboard_image_unsupported_media_type",
            type: "error",
          };
        }

        return {
          image,
          mediaType,
          type: "image",
        };
      } catch (error) {
        return commandErrorResult(error, command.command);
      }
    },
  };
}

function selectClipboardImageCommand(
  platform: NodeJS.Platform | string,
  env: ClipboardImageEnv
): ClipboardImageCommand | undefined {
  if (platform === "darwin") {
    return {
      args: ["-b"],
      command: "pngpaste",
      input: undefined,
      outputEncoding: "base64",
    };
  }

  if (platform !== "linux") {
    return;
  }

  if (nonEmpty(env.WAYLAND_DISPLAY)) {
    return {
      args: ["--type", "image/png"],
      command: "wl-paste",
      input: undefined,
      mediaType: "image/png",
      outputEncoding: "bytes",
    };
  }

  if (nonEmpty(env.DISPLAY)) {
    return {
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
      command: "xclip",
      input: undefined,
      mediaType: "image/png",
      outputEncoding: "bytes",
    };
  }

  return;
}

async function runClipboardImageCommand(
  command: ClipboardImageCommand
): Promise<ClipboardImageCommandResult> {
  const { stdout } = await execFileAsync(command.command, [...command.args], {
    encoding: "buffer",
    maxBuffer: DEFAULT_CLIPBOARD_IMAGE_MAX_BYTES + 1,
  });

  return { stdout };
}

function commandErrorResult(
  error: unknown,
  command: string
): ClipboardImageErrorResult | ClipboardImageNoImageResult {
  if (isMissingCommandError(error)) {
    return {
      message: `Clipboard image reader command ${command} was not found. Install it and try again.`,
      reason: "clipboard_image_command_missing",
      type: "error",
    };
  }

  return noImageResult();
}

function detectImageMediaType(
  image: Uint8Array
): ClipboardImageMediaType | undefined {
  if (
    image[0] === 0x89 &&
    image[1] === 0x50 &&
    image[2] === 0x4e &&
    image[3] === 0x47 &&
    image[4] === 0x0d &&
    image[5] === 0x0a &&
    image[6] === 0x1a &&
    image[7] === 0x0a
  ) {
    return "image/png";
  }

  if (image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return "image/jpeg";
  }

  return;
}

function isMissingCommandError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalizeNonImageResult(
  result: ClipboardImageErrorResult | ClipboardImageNoImageResult
): ClipboardImageErrorResult | ClipboardImageNoImageResult {
  if (result.type === "no-image" && !result.message) {
    return noImageResult();
  }

  return result;
}

function noImageResult(): ClipboardImageNoImageResult {
  return {
    message: "Clipboard does not contain a PNG or JPEG image.",
    reason: "clipboard_image_not_found",
    type: "no-image",
  };
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function readSupportedMediaType(
  mediaType: string
): ClipboardImageMediaType | undefined {
  return mediaType === "image/png" || mediaType === "image/jpeg"
    ? mediaType
    : undefined;
}

function toUint8Array(
  value: Buffer | Uint8Array | string,
  outputEncoding: "base64" | "bytes"
): Uint8Array {
  if (outputEncoding === "base64") {
    return Buffer.from(Buffer.from(value).toString("utf8").trim(), "base64");
  }

  if (typeof value === "string") {
    return Buffer.from(value);
  }

  return value;
}

function unsupportedPlatformResult(
  platform: NodeJS.Platform | string
): ClipboardImageErrorResult {
  return {
    message:
      platform === "linux"
        ? "No supported clipboard image reader is available. Set WAYLAND_DISPLAY or DISPLAY and install wl-paste or xclip."
        : "No supported clipboard image reader is available.",
    reason: "clipboard_image_unsupported_platform",
    type: "error",
  };
}
