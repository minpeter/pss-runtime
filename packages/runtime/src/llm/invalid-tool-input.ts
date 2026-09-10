import { InvalidToolInputError, JSONParseError } from "ai";
import type { ModelStepStreamFinalResult } from "./model-step-stream";

/** Only SDK-rejected calls qualify; executor error text is not evidence of rejection. */
export function normalizeInvalidToolResults({
  responseMessages,
  finalStep,
  finishReason,
  startedToolCalls,
}: Pick<
  ModelStepStreamFinalResult,
  "responseMessages" | "finalStep" | "finishReason"
> & {
  readonly startedToolCalls: readonly { id: string; toolName: string }[];
}): {
  readonly messages: ModelStepStreamFinalResult["responseMessages"];
  readonly rejectedOnly: boolean;
} {
  const calls = finalStep?.toolCalls ?? [];
  const assistantCalls = responseMessages.flatMap((message) =>
    message.role === "assistant" && typeof message.content !== "string"
      ? message.content.filter((part) => part.type === "tool-call")
      : []
  );
  const results = responseMessages.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-result")
      : []
  );
  const rejected = new Map(
    calls.flatMap((call) => {
      if (
        !call.invalid ||
        call.providerExecuted ||
        !InvalidToolInputError.isInstance(call.error) ||
        calls.filter((candidate) => candidate.toolCallId === call.toolCallId)
          .length !== 1
      ) {
        return [];
      }
      const pairedCalls = assistantCalls.filter(
        (part) => part.toolCallId === call.toolCallId
      );
      const pairedResults = results.filter(
        (part) => part.toolCallId === call.toolCallId
      );
      if (
        pairedCalls.length !== 1 ||
        pairedCalls[0]?.toolName !== call.toolName ||
        pairedCalls[0]?.providerExecuted ||
        pairedResults.length !== 1 ||
        pairedResults[0]?.toolName !== call.toolName
      ) {
        return [];
      }
      return [[call.toolCallId, call] as const];
    })
  );
  const messages = responseMessages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") {
          return part;
        }
        const call = rejected.get(part.toolCallId);
        if (
          call === undefined ||
          !InvalidToolInputError.isInstance(call.error)
        ) {
          return part;
        }
        const error = call.error;
        const malformedJson = JSONParseError.isInstance(error.cause);
        return {
          ...part,
          output: {
            type: "error-json" as const,
            value: {
              code: "INVALID_TOOL_ARGUMENTS",
              kind: malformedJson ? "json-parse" : "schema-validation",
              message: malformedJson
                ? "Tool arguments are invalid or incomplete JSON. This tool was not executed. If output was truncated, retry using smaller writes or edits; generating a long file in one call may exceed generation limits. Do not use incomplete content or invent overwrite hashes."
                : "Tool arguments do not match the input schema. This tool was not executed. Correct the required fields and their types before submitting a new call. Do not invent overwrite hashes.",
              inputCharacters: error.toolInput.length,
              ...(finishReason === "length" ? { finishReason } : {}),
            },
          },
        };
      }),
    };
  });
  return {
    messages,
    // A finalized rejection is feedback, not unfinished generation. A sibling
    // that only started streaming must not disappear behind that rejection.
    rejectedOnly:
      rejected.size > 0 &&
      rejected.size === calls.length &&
      assistantCalls.length === calls.length &&
      results.length === calls.length &&
      startedToolCalls.every(
        (start) =>
          rejected.get(start.id)?.toolName === start.toolName &&
          startedToolCalls.filter((candidate) => candidate.id === start.id)
            .length === 1
      ),
  };
}
