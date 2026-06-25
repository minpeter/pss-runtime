import { jsonSchema, type ToolSet, tool } from "ai";

export const tools = {
  get_weather: tool({
    description: "Get the current weather for a city.",
    execute: async () => ({ city: "서울", condition: "맑음", tempC: 21 }),
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    }),
  }),
  send_email: tool({
    description: "Send an email to a recipient. Has real side effects.",
    execute: async () => ({ sent: true }),
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: {
        body: { type: "string" },
        to: { type: "string" },
      },
      required: ["body", "to"],
      type: "object",
    }),
  }),
} satisfies ToolSet;

export const instructions =
  "You are a helpful assistant. Answer in Korean. " +
  "Use get_weather for weather questions. " +
  "Never send email without confirming the exact recipient address.";
