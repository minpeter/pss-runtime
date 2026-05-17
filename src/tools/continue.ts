import { jsonSchema, tool } from "ai";

export const continueTool = tool({
  description:
    "Request one more agent loop step before producing a final answer.",
  execute: () => ({}),
  inputSchema: jsonSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  outputSchema: jsonSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
});
