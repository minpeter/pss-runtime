import { jsonSchema, type ToolSet, tool } from "ai";

export function createStressTools(): ToolSet {
  return {
    worker_echo: tool({
      description: "Echo a bounded diagnostic message.",
      execute: (input: unknown) => ({ echoed: readMessage(input) }),
      inputSchema: jsonSchema({
        additionalProperties: false,
        properties: {
          message: { maxLength: 120, minLength: 1, type: "string" },
        },
        required: ["message"],
        type: "object",
      }),
      outputSchema: jsonSchema({
        additionalProperties: false,
        properties: {
          echoed: { type: "string" },
        },
        required: ["echoed"],
        type: "object",
      }),
    }),
  } satisfies ToolSet;
}

function readMessage(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "message" in input &&
    typeof input.message === "string"
  ) {
    return input.message;
  }
  return "missing-message";
}
