import { Agent, createLookAtLlm } from "@minpeter/pss-runtime";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardImageReader } from "./clipboard-image";
import { createTuiRunner } from "./tui-runner";

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

const mainModel = { provider: "test", modelId: "main" } as LanguageModel;
const visionModel = { provider: "test", modelId: "vision" } as LanguageModel;
const pngBytes = Buffer.from("red-square-fixture");
const dataImageNeedle = ["data", "image"].join(":");
const pngDataUri = `${dataImageNeedle}/png;base64,${pngBytes.toString("base64")}`;

describe("look_at image delegation through the coding-agent TUI path", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("keeps raw image data out of main model and TUI output while delegating to vision", async () => {
    generateTextMock.mockImplementation(async (options) => {
      if (options.model === visionModel) {
        return { text: "a red square" };
      }

      const callIndex = generateTextMock.mock.calls.filter(
        ([callOptions]) => callOptions.model === mainModel
      ).length;

      if (callIndex === 1) {
        const toolCall = {
          type: "tool-call" as const,
          toolCallId: "call-look-at-1",
          toolName: "look_at",
          input: { imageId: "image_1", question: "What is in this image?" },
        };
        const toolResult = await options.tools.look_at.execute(toolCall.input, {
          abortSignal: options.abortSignal,
          messages: [],
          toolCallId: toolCall.toolCallId,
        });

        return {
          responseMessages: [
            { role: "assistant", content: [toolCall] },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  output: { type: "json", value: toolResult },
                },
              ],
            },
          ],
        };
      }

      const visionText = findVisionText(options.messages);
      if (visionText) {
        return {
          responseMessages: [
            {
              role: "assistant",
              content: `The vision result is ${visionText}.`,
            },
          ],
        };
      }

      return {
        responseMessages: [
          { role: "assistant", content: "The vision result was unavailable." },
        ],
      };
    });

    const llm = createLookAtLlm({ model: mainModel, visionModel });
    const agent = await Agent.create({ llm });
    const lines: string[] = [];
    const runner = createTuiRunner({
      addLine: (line) => lines.push(line),
      clipboardImageReader: createClipboardImageReader(),
      requestRender: vi.fn(),
      session: agent.session("look-at-integration"),
    });

    await runner.attachClipboardImage();
    runner.submit("What is in this image?");
    await waitUntil(() => lines.some((line) => line.includes("a red square")));
    await waitUntil(() => runner.activeRun === undefined);

    const mainCalls = generateTextMock.mock.calls
      .map(([options]) => options)
      .filter((options) => options.model === mainModel);
    const visionCalls = generateTextMock.mock.calls
      .map(([options]) => options)
      .filter((options) => options.model === visionModel);

    expect(mainCalls).toHaveLength(2);
    expect(visionCalls).toHaveLength(1);
    expect(JSON.stringify(mainCalls)).toContain("[image image_1 image/png]");
    expect(JSON.stringify(mainCalls)).not.toContain(dataImageNeedle);
    expect(JSON.stringify(mainCalls)).not.toContain(pngDataUri);
    expect(visionCalls[0].messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "file", data: pngDataUri, mediaType: "image/png" },
        ],
      },
    ]);
    expect(lines).toContain("\x1b[2m[attached image/png]\x1b[0m");
    expect(lines.some((line) => line.includes("a red square"))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(dataImageNeedle);
  });
});

function findVisionText(messages: unknown): string | undefined {
  const text = JSON.stringify(messages);
  return text.includes("a red square") ? "a red square" : undefined;
}

function createClipboardImageReader(): ClipboardImageReader {
  return {
    read: () =>
      Promise.resolve({
        image: pngBytes,
        mediaType: "image/png",
        type: "image",
      }),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for look_at integration test condition");
}
