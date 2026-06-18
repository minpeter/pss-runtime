import type {
  AgentInput,
  UserInput,
  UserMessage,
  UserMessageContentPart,
  UserText,
} from "./input";

export function normalizeAgentInput(input: AgentInput): UserInput {
  if (typeof input === "string") {
    return {
      type: "user-text",
      text: input,
    };
  }

  if (isStringArrayInput(input)) {
    return {
      type: "user-text",
      text: structuredClone(input),
    };
  }

  if (isArrayInput(input)) {
    assertUserMessageContent(input);
    return {
      type: "user-message",
      content: structuredClone(input),
    };
  }

  if (isUserMessage(input)) {
    assertUserMessageContent(input.content);
    return structuredClone(input);
  }

  if (isUserText(input)) {
    return structuredClone(input);
  }

  throw new TypeError(
    "Agent input must be text, text parts, content parts, user-text, or user-message."
  );
}

function isStringArrayInput(input: unknown): input is readonly string[] {
  return Array.isArray(input) && hasDenseItems(input, isString);
}

function isArrayInput(
  input: AgentInput
): input is readonly string[] | readonly UserMessageContentPart[] {
  return Array.isArray(input);
}

function isUserMessage(input: AgentInput): input is UserMessage {
  return (
    input !== null &&
    typeof input === "object" &&
    !isArrayInput(input) &&
    input.type === "user-message" &&
    "content" in input &&
    Array.isArray(input.content)
  );
}

function isUserText(input: AgentInput): input is UserText {
  return (
    input !== null &&
    typeof input === "object" &&
    !isArrayInput(input) &&
    input.type === "user-text" &&
    (typeof input.text === "string" || isStringArrayInput(input.text))
  );
}

function assertUserMessageContent(
  input: readonly unknown[]
): asserts input is readonly UserMessageContentPart[] {
  for (const part of input) {
    if (!isUserMessageContentPart(part)) {
      throw new TypeError(
        'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
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

  if (part.type === "image") {
    return (
      "image" in part &&
      typeof part.image === "string" &&
      (!("mediaType" in part) || typeof part.mediaType === "string")
    );
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

  if (data === null || typeof data !== "object" || !("type" in data)) {
    return false;
  }

  if (data.type === "data") {
    return "data" in data && typeof data.data === "string";
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
