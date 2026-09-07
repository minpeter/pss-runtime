import { InvalidToolInputError, JSONParseError } from "ai";
import type { ModelStepStreamFinalResult } from "./model-step-stream";

/** Only SDK-rejected calls qualify; executor error text is not evidence of rejection. */
export function normalizeInvalidToolResults({
  responseMessages,
  finalStep,
  finishReason,
}: Pick<
  ModelStepStreamFinalResult,
  "responseMessages" | "finalStep" | "finishReason"
>): ModelStepStreamFinalResult["responseMessages"] {
  const rejected = new Map(
    (finalStep?.toolCalls ?? []).flatMap((call) => {
      if (
        !call.invalid ||
        call.providerExecuted ||
        !InvalidToolInputError.isInstance(call.error)
      ) {
        return [];
      }
      return [[call.toolCallId, call.error] as const];
    })
  );
  return responseMessages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") {
          return part;
        }
        const error = rejected.get(part.toolCallId);
        if (error === undefined) {
          return part;
        }
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
}
