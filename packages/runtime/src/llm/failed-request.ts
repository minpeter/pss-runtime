import type { ModelMessage } from "ai";

/** A provider threw a value that cannot itself carry request metadata. */
export class PrimitiveProviderError extends Error {
  override readonly name = "PrimitiveProviderError";
  constructor(cause: unknown) {
    super("The provider request failed.", { cause });
  }
}

/** A physical finish explicitly reported failure, without an exception. */
export class ProviderReportedError extends Error {
  override readonly name = "ProviderReportedError";
  readonly finishReason = "error";
  readonly rawFinishReason: string | undefined;
  constructor(rawFinishReason: string | undefined) {
    super("The provider reported an error finish.");
    this.rawFinishReason = rawFinishReason;
  }
}

export function normalizeProviderException(error: unknown): unknown {
  return (typeof error === "object" && error !== null) ||
    typeof error === "function"
    ? error
    : new PrimitiveProviderError(error);
}

// Metadata is attached only at the LLM boundary, never inferred from arbitrary
// runtime exceptions. Keeping the original error preserves rollback consumers.
const failures = new WeakMap<object, readonly ModelMessage[]>();

export function recordFailedRequest(
  error: unknown,
  messages: readonly ModelMessage[]
): void {
  if (typeof error === "object" && error !== null) {
    failures.set(error, messages);
  }
}

export function failedRequestMessages(
  error: unknown
): readonly ModelMessage[] | undefined {
  if (typeof error !== "object" || error === null) {
    return;
  }
  const messages = failures.get(error);
  failures.delete(error);
  return messages;
}

export function safeFailedMessages(
  messages: readonly ModelMessage[]
): Extract<ModelMessage, { role: "assistant" | "tool" }>[] {
  const results = new Set(
    messages.flatMap((message) =>
      message.role === "tool"
        ? message.content
            .filter((part) => part.type === "tool-result")
            .map((part) => part.toolCallId)
        : []
    )
  );
  const safe: Extract<ModelMessage, { role: "assistant" | "tool" }>[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content =
        typeof message.content === "string"
          ? []
          : message.content.filter(
              (part) =>
                part.type === "tool-call" && results.has(part.toolCallId)
            );
      if (content.length) {
        safe.push({ role: "assistant", content });
      }
    } else if (message.role === "tool") {
      safe.push(message);
    }
  }
  // Interrupted assistant prose is a draft, not a model-context message. The
  // next request is regenerated from the preceding safe checkpoint.
  return safe;
}
