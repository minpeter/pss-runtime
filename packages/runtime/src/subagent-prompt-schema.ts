const fileDataSchema = {
  anyOf: [
    { type: "string" },
    {
      additionalProperties: false,
      properties: {
        data: { type: "string" },
        type: { const: "data" },
      },
      required: ["type", "data"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        reference: {
          additionalProperties: { type: "string" },
          type: "object",
        },
        type: { const: "reference" },
      },
      required: ["type", "reference"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        type: { const: "text" },
      },
      required: ["type", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        type: { const: "url" },
        url: { type: "string" },
      },
      required: ["type", "url"],
      type: "object",
    },
  ],
};

const contentPartSchema = {
  anyOf: [
    {
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        type: { const: "text" },
      },
      required: ["type", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        image: { type: "string" },
        mediaType: { type: "string" },
        type: { const: "image" },
      },
      required: ["type", "image"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        data: fileDataSchema,
        filename: { type: "string" },
        mediaType: { type: "string" },
        type: { const: "file" },
      },
      required: ["type", "data", "mediaType"],
      type: "object",
    },
  ],
};

const contentArraySchema = {
  items: contentPartSchema,
  type: "array",
};

export const delegatePromptSchema = {
  anyOf: [
    { type: "string" },
    { items: { type: "string" }, type: "array" },
    {
      additionalProperties: false,
      properties: {
        text: {
          anyOf: [
            { type: "string" },
            { items: { type: "string" }, type: "array" },
          ],
        },
        type: { const: "user-text" },
      },
      required: ["type", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        content: contentArraySchema,
        type: { const: "user-message" },
      },
      required: ["type", "content"],
      type: "object",
    },
    contentArraySchema,
  ],
};
