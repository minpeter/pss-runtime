import type {
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
  ToolSet,
} from "ai";
import { generateText, jsonSchema, tool } from "ai";
import type { AgentToolChoice, Llm, LlmOutput } from "./llm";

export const DEFAULT_LOOK_AT_TOOL_NAME = "look_at";
export const DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS = 2000;
export const DEFAULT_LOOK_AT_MAX_IMAGE_BYTES = 10_485_760;
export const DEFAULT_LOOK_AT_ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
] as const;

const TRUNCATED_SUFFIX = "…[truncated]";
const IMAGE_DATA_URL_PATTERN = new RegExp(
  ["data:", "image/[^\\s)\\]}]+"].join(""),
  "gi"
);
const BASE64_DATA_URL_PATTERN = /^data:[^,]*;base64,([a-z0-9+/=\r\n]+)$/i;
const BASE64_LINE_BREAK_PATTERN = /[\r\n]/g;

export interface CreateLookAtLlmOptions {
  allowedMediaTypes?: readonly string[];
  instructions?: string;
  maxImageBytes?: number;
  maxOutputChars?: number;
  model: LanguageModel;
  toolChoice?: AgentToolChoice;
  toolName?: string;
  tools?: ToolSet;
  visionModel: LanguageModel;
}

interface ImageHandle {
  readonly id: string;
  readonly mediaType: string;
  readonly part: Record<string, unknown>;
}

type SanitizedContentPart =
  | { text: string; type: "text" }
  | Record<string, unknown>;

type LookAtResult =
  | { imageId: string; ok: true; text: string; truncated: boolean }
  | { error: { code: string; message: string }; imageId?: string; ok: false };

export function createLookAtLlm({
  allowedMediaTypes = DEFAULT_LOOK_AT_ALLOWED_MEDIA_TYPES,
  instructions,
  maxImageBytes = DEFAULT_LOOK_AT_MAX_IMAGE_BYTES,
  maxOutputChars = DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS,
  model,
  toolChoice,
  toolName = DEFAULT_LOOK_AT_TOOL_NAME,
  tools,
  visionModel,
}: CreateLookAtLlmOptions): Llm {
  if (tools && toolName in tools) {
    throw new Error(
      `${toolName} tool conflict: createLookAtLlm injects this tool`
    );
  }

  const allowedMediaTypeSet = new Set(allowedMediaTypes);

  return async ({ history, signal }) => {
    const handles = new Map<string, ImageHandle>();
    const messages = sanitizeMessages(history, {
      allowedMediaTypeSet,
      handles,
      maxImageBytes,
    });

    const lookAtTool = createLookAtTool({
      handles,
      maxOutputChars,
      signal,
      visionModel,
    });

    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages,
      model,
      toolChoice,
      tools: { ...(tools ?? {}), [toolName]: lookAtTool },
    });

    return responseMessages as LlmOutput;
  };
}

function sanitizeMessages(
  history: readonly ModelMessage[],
  options: {
    allowedMediaTypeSet: ReadonlySet<string>;
    handles: Map<string, ImageHandle>;
    maxImageBytes: number;
  }
): ModelMessage[] {
  return history.map((message) => sanitizeMessage(message, options));
}

function sanitizeMessage(
  message: ModelMessage,
  options: {
    allowedMediaTypeSet: ReadonlySet<string>;
    handles: Map<string, ImageHandle>;
    maxImageBytes: number;
  }
): ModelMessage {
  if (message.role === "system") {
    return sanitizeSystemMessage(message);
  }

  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((part) =>
        sanitizeContentPart(part, options)
      ),
    } as ModelMessage;
  }

  if (typeof message.content === "string") {
    return { ...message, content: sanitizeText(message.content) };
  }

  return {
    ...message,
    content: message.content.map((part) => sanitizeContentPart(part, options)),
  } as ModelMessage;
}

function sanitizeSystemMessage(
  message: SystemModelMessage
): SystemModelMessage {
  return { ...message, content: sanitizeText(message.content) };
}

function sanitizeContentPart(
  part: unknown,
  options: {
    allowedMediaTypeSet: ReadonlySet<string>;
    handles: Map<string, ImageHandle>;
    maxImageBytes: number;
  }
): SanitizedContentPart {
  if (!isRecord(part)) {
    return { type: "text", text: "[unsupported content part omitted]" };
  }

  if (part.type === "text") {
    return { ...part, text: sanitizeText(String(part.text ?? "")) };
  }

  if (part.type === "image" || part.type === "file") {
    const imagePart = imageHandleCandidate(part, options);
    if (!imagePart.ok) {
      return { type: "text", text: `[${imagePart.reason}]` };
    }

    const id = `image_${options.handles.size + 1}`;
    options.handles.set(id, {
      id,
      mediaType: imagePart.mediaType,
      part: { ...part },
    });

    return {
      type: "text",
      text: `[image ${id} ${imagePart.mediaType}]`,
    };
  }

  return sanitizeUnknownValue(part) as SanitizedContentPart;
}

function sanitizeUnknownValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeUnknownValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeUnknownValue(entry),
      ])
    );
  }

  return value;
}

function sanitizeText(text: string): string {
  return text.replace(IMAGE_DATA_URL_PATTERN, "[image data omitted]");
}

function imageHandleCandidate(
  part: Record<string, unknown>,
  options: {
    allowedMediaTypeSet: ReadonlySet<string>;
    maxImageBytes: number;
  }
):
  | { mediaType: string; ok: true }
  | {
      ok: false;
      reason:
        | "image omitted: media type not allowed"
        | "image omitted: unsupported data"
        | "image omitted: too large"
        | "file omitted";
    } {
  const mediaType =
    typeof part.mediaType === "string" ? part.mediaType : "image";
  const data = part.type === "image" ? part.image : part.data;

  if (part.type === "file" && !mediaType.startsWith("image/")) {
    return { ok: false, reason: "file omitted" };
  }

  if (!options.allowedMediaTypeSet.has(mediaType)) {
    return { ok: false, reason: "image omitted: media type not allowed" };
  }

  const size = contentByteLength(data);
  if (size === undefined) {
    return { ok: false, reason: "image omitted: unsupported data" };
  }

  if (size > options.maxImageBytes) {
    return { ok: false, reason: "image omitted: too large" };
  }

  return { mediaType, ok: true };
}

function contentByteLength(value: unknown): number | undefined {
  if (typeof value === "string") {
    return (
      dataUrlDecodedByteLength(value) ??
      new TextEncoder().encode(value).byteLength
    );
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }

  if (isRecord(value) && value.type === "data") {
    return contentByteLength(value.data);
  }

  return;
}

function dataUrlDecodedByteLength(value: string): number | undefined {
  const match = BASE64_DATA_URL_PATTERN.exec(value);
  if (!match) {
    return;
  }

  const base64 = match[1].replace(BASE64_LINE_BREAK_PATTERN, "");
  let padding = 0;
  if (base64.endsWith("==")) {
    padding = 2;
  } else if (base64.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, (base64.length / 4) * 3 - padding);
}

function truncateText(text: string, maxOutputChars: number): string {
  return `${text.slice(0, Math.max(0, maxOutputChars))}${TRUNCATED_SUFFIX}`;
}

function createLookAtTool({
  handles,
  maxOutputChars,
  signal,
  visionModel,
}: {
  handles: ReadonlyMap<string, ImageHandle>;
  maxOutputChars: number;
  signal: AbortSignal;
  visionModel: LanguageModel;
}) {
  return tool({
    description: "Inspect a previously attached image by handle.",
    execute: async (input: unknown, options): Promise<LookAtResult> => {
      const parsed = parseLookAtInput(input);
      if (!parsed.ok) {
        return safeError(
          "invalid_input",
          "look_at requires imageId and question strings"
        );
      }

      const handle = handles.get(parsed.imageId);
      if (!handle) {
        return safeError(
          "unknown_image",
          "Unknown image handle",
          parsed.imageId
        );
      }

      try {
        const result = await generateText({
          abortSignal: options.abortSignal ?? signal,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: parsed.question },
                { ...handle.part } as never,
              ],
            },
          ],
          model: visionModel,
        });
        const text = sanitizeText(
          typeof result.text === "string" ? result.text : ""
        );
        const truncated = text.length > maxOutputChars;

        return {
          imageId: parsed.imageId,
          ok: true,
          text: truncated ? truncateText(text, maxOutputChars) : text,
          truncated,
        };
      } catch {
        return safeError(
          "vision_model_error",
          "Vision model failed",
          parsed.imageId
        );
      }
    },
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        imageId: { type: "string" },
        question: { type: "string" },
      },
      required: ["imageId", "question"],
      additionalProperties: false,
    }),
    outputSchema: jsonSchema({
      type: "object",
      additionalProperties: true,
    }),
  });
}

function parseLookAtInput(
  input: unknown
): { imageId: string; ok: true; question: string } | { ok: false } {
  if (
    !isRecord(input) ||
    typeof input.imageId !== "string" ||
    typeof input.question !== "string"
  ) {
    return { ok: false };
  }

  return { imageId: input.imageId, ok: true, question: input.question };
}

function safeError(
  code: string,
  message: string,
  imageId?: string
): LookAtResult {
  return {
    ...(imageId === undefined ? {} : { imageId }),
    error: { code, message },
    ok: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
