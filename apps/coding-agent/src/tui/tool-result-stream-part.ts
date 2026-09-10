import type { TuiStreamPart } from "./stream-handlers";

/** Classify only the outer SDK envelope, never a successful JSON payload. */
export const toolResultStreamPart = ({
  output,
  toolCallId,
  toolName,
}: {
  readonly output: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}): TuiStreamPart => {
  const identity = { toolCallId, toolName };
  if (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "type" in output
  ) {
    switch (output.type) {
      case "error-text":
      case "error-json":
        return {
          ...identity,
          type: "tool-error",
          error: "value" in output ? output.value : undefined,
        };
      case "execution-denied":
        return {
          ...identity,
          type: "tool-output-denied",
          ...("reason" in output && output.reason !== undefined
            ? { reason: output.reason }
            : {}),
        };
      case "text":
      case "json":
        if ("value" in output) {
          return { ...identity, type: "tool-result", output: output.value };
        }
        break;
      default:
        break;
    }
  }
  // Content envelopes and unknown/raw outputs retain their existing shape.
  return { ...identity, type: "tool-result", output };
};
