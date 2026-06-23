import type { Attributes } from "@opentelemetry/api";
import type {
  AgentEvent,
  UserInput,
  UserMessageContentPart,
} from "../thread/protocol/events";

export function defaultAgentEventAttributes(event: AgentEvent): Attributes {
  const base: Attributes = { "pss.event.type": event.type };

  switch (event.type) {
    case "assistant-output":
      return { ...base, "pss.assistant_output.text_length": event.text.length };
    case "assistant-reasoning":
      return {
        ...base,
        "pss.assistant_reasoning.text_length": event.text.length,
      };
    case "runtime-input":
      return {
        ...base,
        "pss.runtime_input.placement": event.placement,
        ...inputAttributes(
          "pss.runtime_input",
          event.input,
          event.meta ?? event.input.meta
        ),
      };
    case "step-end":
    case "step-start":
    case "turn-end":
    case "turn-start":
      return base;
    case "tool-call":
      return {
        ...base,
        "pss.tool.call_id": event.toolCallId,
        "pss.tool.input.type": payloadType(event.input),
        "pss.tool.name": event.toolName,
        ...payloadSummaryAttributes("pss.tool.input", event.input),
      };
    case "tool-result":
      return {
        ...base,
        "pss.tool.call_id": event.toolCallId,
        "pss.tool.name": event.toolName,
        "pss.tool.output.type": payloadType(event.output),
        ...payloadSummaryAttributes("pss.tool.output", event.output),
      };
    case "turn-abort":
      return { ...base, "pss.turn.abort": true };
    case "turn-error":
      return { ...base, "pss.turn.error": true };
    case "user-input":
      return { ...base, ...inputAttributes("pss.user_input", event) };
    default:
      return assertNever(event);
  }
}

export function cleanAttributes(
  attributes: Attributes
): Attributes | undefined {
  const cleaned: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function mergeAttributes(
  base: Attributes,
  extra: Attributes | undefined
): Attributes | undefined {
  return cleanAttributes(extra === undefined ? base : { ...base, ...extra });
}

function inputAttributes(
  prefix: string,
  input: UserInput,
  meta = input.meta
): Attributes {
  const metaAttributes = meta?.source
    ? { "pss.input.source": meta.source }
    : {};

  if ("text" in input) {
    return {
      ...metaAttributes,
      [`${prefix}.kind`]: "text",
      ...textContentAttributes(prefix, input.text),
    };
  }

  const summary = messageContentSummary(input.content);
  return {
    ...metaAttributes,
    [`${prefix}.file_count`]: summary.fileCount,
    [`${prefix}.image_count`]: summary.imageCount,
    [`${prefix}.kind`]: "message",
    [`${prefix}.part_count`]: input.content.length,
    [`${prefix}.text_length`]: summary.textLength,
    [`${prefix}.text_part_count`]: summary.textPartCount,
  };
}

function messageContentSummary(content: readonly UserMessageContentPart[]) {
  let fileCount = 0;
  let imageCount = 0;
  let textLength = 0;
  let textPartCount = 0;

  for (const part of content) {
    switch (part.type) {
      case "file":
        fileCount += 1;
        break;
      case "image":
        imageCount += 1;
        break;
      case "text":
        textLength += part.text.length;
        textPartCount += 1;
        break;
      default:
        assertNever(part);
    }
  }

  return { fileCount, imageCount, textLength, textPartCount };
}

function payloadType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function payloadSummaryAttributes(prefix: string, value: unknown): Attributes {
  if (typeof value === "string") {
    return { [`${prefix}.text_length`]: value.length };
  }
  if (Array.isArray(value)) {
    return { [`${prefix}.item_count`]: value.length };
  }
  if (typeof value === "object" && value !== null) {
    const keyCount = objectKeyCount(value);
    return keyCount === undefined ? {} : { [`${prefix}.key_count`]: keyCount };
  }
  return {};
}

function objectKeyCount(value: object): number | undefined {
  try {
    return Object.keys(value).length;
  } catch {
    return;
  }
}

function textContentAttributes(
  prefix: string,
  text: string | readonly string[]
): Attributes {
  if (typeof text === "string") {
    return {
      [`${prefix}.part_count`]: 1,
      [`${prefix}.text_length`]: text.length,
    };
  }

  return {
    [`${prefix}.part_count`]: text.length,
    [`${prefix}.text_length`]: text.reduce((sum, part) => sum + part.length, 0),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unexpected AgentEvent variant: ${String(value)}`);
}
