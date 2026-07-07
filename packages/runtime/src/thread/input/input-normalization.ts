import type { AgentInput, UserInput, UserMessageContentPart } from "./input";

export function normalizeAgentInput(input: AgentInput): UserInput {
  if (typeof input === "string") {
    return {
      type: "user-input",
      text: input,
    };
  }

  if (isStringArrayInput(input)) {
    return {
      type: "user-input",
      text: structuredClone(input),
    };
  }

  if (isArrayInput(input)) {
    assertUserMessageContent(input);
    return {
      type: "user-input",
      content: structuredClone(input),
    };
  }

  throw new TypeError(
    "Agent input must be text, text parts, or content parts."
  );
}

export function normalizeInternalAgentInput(
  input: AgentInput | UserInput
): UserInput {
  if (isUserInput(input)) {
    return structuredClone(input);
  }

  return normalizeAgentInput(input);
}

function isStringArrayInput(input: unknown): input is readonly string[] {
  return Array.isArray(input) && hasDenseItems(input, isString);
}

function isArrayInput(
  input: AgentInput
): input is readonly string[] | readonly UserMessageContentPart[] {
  return Array.isArray(input);
}

function isUserInput(input: unknown): input is UserInput {
  if (!isRecord(input)) {
    return false;
  }

  if (input.type !== "user-input") {
    return false;
  }

  if ("text" in input && isUserText(input)) {
    return true;
  }

  const content = input.content;
  if (Array.isArray(content)) {
    assertUserMessageContent(content);
    return true;
  }

  return false;
}

function isUserText(input: Record<string, unknown>): boolean {
  return typeof input.text === "string" || isStringArrayInput(input.text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertUserMessageContent(
  input: readonly unknown[]
): asserts input is readonly UserMessageContentPart[] {
  for (const part of input) {
    if (!isUserMessageContentPart(part)) {
      throw new TypeError(
        'Agent input content parts must be { type: "text", text } or { type: "file", data, mediaType }.'
      );
    }
  }
}

function isUserMessageContentPart(
  part: unknown
): part is UserMessageContentPart {
  if (part === null || typeof part !== "object" || !("type" in part)) {
    return false;
  }

  if (part.type === "text") {
    return "text" in part && typeof part.text === "string";
  }

  if (part.type === "file") {
    return (
      "data" in part &&
      isUserMessageFileData(part.data) &&
      "mediaType" in part &&
      typeof part.mediaType === "string" &&
      (!("filename" in part) || typeof part.filename === "string")
    );
  }

  return false;
}

function isUserMessageFileData(data: unknown): boolean {
  if (typeof data === "string") {
    return true;
  }

  if (isBinaryFileData(data)) {
    return true;
  }

  if (data === null || typeof data !== "object" || !("type" in data)) {
    return false;
  }

  if (data.type === "data") {
    return (
      "data" in data &&
      (typeof data.data === "string" || isBinaryFileData(data.data))
    );
  }

  if (data.type === "reference") {
    return (
      "reference" in data &&
      data.reference !== null &&
      typeof data.reference === "object" &&
      Object.values(data.reference).every((value) => typeof value === "string")
    );
  }

  if (data.type === "text") {
    return "text" in data && typeof data.text === "string";
  }

  if (data.type === "url") {
    return "url" in data && typeof data.url === "string";
  }

  return false;
}

function isBinaryFileData(data: unknown): data is ArrayBuffer | Uint8Array {
  return data instanceof ArrayBuffer || data instanceof Uint8Array;
}

function hasDenseItems<T>(
  input: readonly unknown[],
  predicate: (value: unknown) => value is T
): input is readonly T[] {
  for (let index = 0; index < input.length; index += 1) {
    if (!(index in input && predicate(input[index]))) {
      return false;
    }
  }

  return true;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
