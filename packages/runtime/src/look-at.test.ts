import type { LanguageModel, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, createLookAtLlm } from "./index";
import { assistantMessage, userText } from "./test-fixtures";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  return {
    ...actual,
    generateText: generateTextMock,
  };
});

const fakeModel = {} as LanguageModel;
const fakeVisionModel = {
  provider: "test",
  modelId: "vision",
} as LanguageModel;
const LOOK_AT_CONFLICT_PATTERN = /look_at.*conflict/i;
const dataImageUrl = (mediaType: string, payload = "ZmFrZQ==") =>
  `data:${mediaType};base64,${payload}`;

const createNoopTool = () =>
  tool({
    description: "No-op test tool.",
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

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  let eventCount = 0;
  for await (const _event of run.events()) {
    eventCount += 1;
  }
  return eventCount;
}

describe("createLookAtLlm", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  it("is exported from the public runtime source index", () => {
    expect(createLookAtLlm).toEqual(expect.any(Function));
  });

  it("returns an LLM accepted by Agent.create through the custom llm seam", async () => {
    const llm = createLookAtLlm({
      model: fakeModel,
      visionModel: fakeVisionModel,
    });

    const agent = await Agent.create({ llm });

    await drainRun(
      await agent.send(userText("describe the available context"))
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
      })
    );
  });

  it("passes caller options through while adding the default look_at tool", async () => {
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const llm = createLookAtLlm({
      allowedMediaTypes: ["image/png", "application/pdf"],
      instructions: "test instructions",
      maxImageBytes: 1024,
      maxOutputChars: 2000,
      model: fakeModel,
      toolChoice: "required",
      tools: injectedTools,
      visionModel: fakeVisionModel,
    });

    await expect(llm({ history, signal })).resolves.toEqual([
      assistantMessage("DONE"),
    ]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: signal,
        instructions: "test instructions",
        messages: history,
        model: fakeModel,
        toolChoice: "required",
        tools: expect.objectContaining({
          injected: injectedTools.injected,
          look_at: expect.any(Object),
        }),
      })
    );
  });

  it("supports a custom look_at tool name", async () => {
    const signal = new AbortController().signal;
    const llm = createLookAtLlm({
      model: fakeModel,
      toolName: "inspect_media",
      visionModel: fakeVisionModel,
    });

    await llm({
      history: [{ role: "user", content: "hello" }],
      signal,
    });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          inspect_media: expect.any(Object),
        }),
      })
    );
  });

  it("rejects caller tools that conflict with the default look_at tool name", () => {
    expect(() =>
      createLookAtLlm({
        model: fakeModel,
        tools: { look_at: createNoopTool() },
        visionModel: fakeVisionModel,
      })
    ).toThrow(LOOK_AT_CONFLICT_PATTERN);
  });

  it("sanitizes supported images into scoped handles for the main model", async () => {
    const originalImage = dataImageUrl("image/png");
    const unsupportedImage = dataImageUrl("image/gif");
    const fileData = "raw text file content";
    const history = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "describe this" },
          {
            type: "file" as const,
            data: originalImage,
            mediaType: "image/png",
          },
          {
            type: "file" as const,
            data: unsupportedImage,
            mediaType: "image/gif",
          },
          { type: "file" as const, data: fileData, mediaType: "text/plain" },
        ],
      },
    ];
    const llm = createLookAtLlm({
      model: fakeModel,
      visionModel: fakeVisionModel,
    });

    await llm({ history, signal: new AbortController().signal });

    const mainCall = generateTextMock.mock.calls[0][0];
    expect(mainCall.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "text", text: "[image image_1 image/png]" },
          { type: "text", text: "[image omitted: media type not allowed]" },
          { type: "text", text: "[file omitted]" },
        ],
      },
    ]);
    expect(JSON.stringify(mainCall.messages)).not.toContain(originalImage);
    expect(JSON.stringify(mainCall.messages)).not.toContain(unsupportedImage);
    expect(JSON.stringify(mainCall.messages)).not.toContain(fileData);
    expect(history[0].content[1]).toEqual({
      type: "file",
      data: originalImage,
      mediaType: "image/png",
    });
  });

  it("omits oversized supported images before creating handles", async () => {
    const imageData = dataImageUrl("image/png");
    const llm = createLookAtLlm({
      maxImageBytes: 1,
      model: fakeModel,
      visionModel: fakeVisionModel,
    });

    await llm({
      history: [
        {
          role: "user",
          content: [{ type: "file", data: imageData, mediaType: "image/png" }],
        },
      ],
      signal: new AbortController().signal,
    });

    const mainCall = generateTextMock.mock.calls[0][0];
    expect(mainCall.messages[0].content).toEqual([
      { type: "text", text: "[image omitted: too large]" },
    ]);
  });

  it("sanitizes data image text markers in existing text content", async () => {
    const llm = createLookAtLlm({
      model: fakeModel,
      visionModel: fakeVisionModel,
    });

    await llm({
      history: [{ role: "user", content: `see ${dataImageUrl("image/png")}` }],
      signal: new AbortController().signal,
    });

    const mainCall = generateTextMock.mock.calls[0][0];
    expect(mainCall.messages).toEqual([
      { role: "user", content: "see [image data omitted]" },
    ]);
  });

  it("look_at calls the vision model with original image data and truncates output", async () => {
    const signal = new AbortController().signal;
    const imageData = dataImageUrl("image/png");
    generateTextMock
      .mockResolvedValueOnce({ responseMessages: [assistantMessage("DONE")] })
      .mockResolvedValueOnce({ text: "abcdef" });
    const llm = createLookAtLlm({
      maxOutputChars: 3,
      model: fakeModel,
      visionModel: fakeVisionModel,
    });

    await llm({
      history: [
        {
          role: "user",
          content: [{ type: "file", data: imageData, mediaType: "image/png" }],
        },
      ],
      signal,
    });

    const lookAtTool = generateTextMock.mock.calls[0][0].tools.look_at;
    await expect(
      lookAtTool.execute(
        { imageId: "image_1", question: "what is shown?" },
        { toolCallId: "call", messages: [], abortSignal: signal }
      )
    ).resolves.toEqual({
      imageId: "image_1",
      ok: true,
      text: "abc…[truncated]",
      truncated: true,
    });
    expect(generateTextMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        abortSignal: signal,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is shown?" },
              { type: "file", data: imageData, mediaType: "image/png" },
            ],
          },
        ],
        model: fakeVisionModel,
      })
    );
  });

  it("look_at returns bounded safe errors for unknown handles and vision failures", async () => {
    generateTextMock
      .mockResolvedValueOnce({ responseMessages: [assistantMessage("DONE")] })
      .mockRejectedValueOnce(new Error("raw provider secret details"));
    const llm = createLookAtLlm({
      model: fakeModel,
      visionModel: fakeVisionModel,
    });

    await llm({
      history: [
        {
          role: "user",
          content: [{ type: "file", data: "ZmFrZQ==", mediaType: "image/png" }],
        },
      ],
      signal: new AbortController().signal,
    });

    const lookAtTool = generateTextMock.mock.calls[0][0].tools.look_at;
    await expect(
      lookAtTool.execute(
        { imageId: "missing", question: "what?" },
        { toolCallId: "call", messages: [] }
      )
    ).resolves.toEqual({
      imageId: "missing",
      error: { code: "unknown_image", message: "Unknown image handle" },
      ok: false,
    });
    await expect(
      lookAtTool.execute(
        { imageId: "image_1", question: "what?" },
        { toolCallId: "call", messages: [] }
      )
    ).resolves.toEqual({
      imageId: "image_1",
      error: { code: "vision_model_error", message: "Vision model failed" },
      ok: false,
    });
  });
});
