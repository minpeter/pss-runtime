import { scenarioIds } from "../request/schema";

export type OpenApiObject = Readonly<Record<string, unknown>>;

export const stringSchema = { type: "string" } as const;

export const errorSchema = {
  additionalProperties: false,
  properties: { error: stringSchema },
  required: ["error"],
  type: "object",
} as const;

export const routeTokenSchema = {
  maxLength: 80,
  minLength: 1,
  type: "string",
} as const;

const stressSchema = {
  additionalProperties: false,
  properties: {
    checkpointBytes: { maximum: 16 * 1024, minimum: 0, type: "integer" },
    fanout: { maximum: 6, minimum: 1, type: "integer" },
    historyItems: { maximum: 32, minimum: 0, type: "integer" },
    pingPongDelayMs: { maximum: 5 * 60 * 1000, minimum: 1, type: "integer" },
    pingPongHops: { maximum: 12, minimum: 1, type: "integer" },
    summaryEvents: { maximum: 24, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;

const scenarioSchema = {
  oneOf: [
    { enum: scenarioIds, type: "string" },
    {
      additionalProperties: false,
      properties: {
        id: { enum: scenarioIds, type: "string" },
        options: {
          additionalProperties: false,
          properties: {
            clock: { const: "compressed", type: "string" },
            delayMs: { maximum: 5 * 60 * 1000, minimum: 1, type: "integer" },
            hops: { maximum: 12, minimum: 1, type: "integer" },
          },
          type: "object",
        },
      },
      required: ["id"],
      type: "object",
    },
  ],
} as const;

const textPartSchema = {
  additionalProperties: false,
  properties: {
    text: { maxLength: 2048, minLength: 1, type: "string" },
    type: { const: "text", type: "string" },
  },
  required: ["text", "type"],
  type: "object",
} as const;

const imagePartSchema = {
  additionalProperties: false,
  properties: {
    image: { maxLength: 2048, minLength: 1, type: "string" },
    mediaType: { maxLength: 80, minLength: 1, type: "string" },
    type: { const: "image", type: "string" },
  },
  required: ["image", "type"],
  type: "object",
} as const;

const filePartSchema = {
  additionalProperties: true,
  properties: {
    filename: { maxLength: 120, minLength: 1, type: "string" },
    mediaType: { maxLength: 120, minLength: 1, type: "string" },
    type: { const: "file", type: "string" },
  },
  required: ["data", "mediaType", "type"],
  type: "object",
} as const;

const inputSchema = {
  oneOf: [
    { maxLength: 2048, minLength: 1, type: "string" },
    {
      items: { oneOf: [textPartSchema, imagePartSchema, filePartSchema] },
      maxItems: 4,
      minItems: 1,
      type: "array",
    },
  ],
} as const;

export const turnRequestSchema = requestSchema({
  conversationId: routeTokenSchema,
  input: inputSchema,
  scenario: scenarioSchema,
  stress: stressSchema,
  tenantId: routeTokenSchema,
  userId: routeTokenSchema,
});

export const pathTurnRequestSchema = requestSchema({
  input: inputSchema,
  scenario: scenarioSchema,
  stress: stressSchema,
});

export const sandboxFileEditRequestSchema = requestSchema({
  content: { maxLength: 8 * 1024, minLength: 1, type: "string" },
  filename: {
    maxLength: 120,
    pattern: "^[A-Za-z0-9._-]+\\.py$",
    type: "string",
  },
});

export const eventResultSchema = {
  additionalProperties: true,
  properties: {
    events: {
      items: { additionalProperties: true, type: "object" },
      type: "array",
    },
    markers: { items: stringSchema, type: "array" },
    scenario: { enum: scenarioIds, type: "string" },
    summary: { additionalProperties: true, type: "object" },
  },
  type: "object",
} as const;

export const runEnvelopeSchema = {
  additionalProperties: false,
  properties: {
    result: eventResultSchema,
    route: { additionalProperties: true, type: "object" },
    runId: { pattern: "^run_[0-9]{4,}$", type: "string" },
    status: { const: "completed", type: "string" },
  },
  required: ["result", "route", "runId", "status"],
  type: "object",
} as const;

export const runEventsSchema = {
  additionalProperties: true,
  properties: {
    events: {
      items: { additionalProperties: true, type: "object" },
      type: "array",
    },
    evidence: { additionalProperties: true, type: "object" },
    markers: { items: stringSchema, type: "array" },
    runId: stringSchema,
    summary: { additionalProperties: true, type: "object" },
  },
  required: ["events", "markers", "runId", "summary"],
  type: "object",
} as const;

export const genericObjectSchema = {
  additionalProperties: true,
  type: "object",
} as const;

export const scenarioListSchema = {
  additionalProperties: false,
  properties: {
    scenarios: {
      items: { additionalProperties: true, type: "object" },
      type: "array",
    },
  },
  required: ["scenarios"],
  type: "object",
} as const;

function requestSchema(properties: OpenApiObject): OpenApiObject {
  return {
    additionalProperties: false,
    properties,
    required: Object.keys(properties).filter((key) => key !== "stress"),
    type: "object",
  };
}
