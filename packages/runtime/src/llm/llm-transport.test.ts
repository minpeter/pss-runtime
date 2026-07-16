import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainRun,
  fakeModel,
  getGenerateTextMock,
  getStreamTextMock,
  loadAgent,
  loadModelStepRunner,
} from "../testing/llm-test-utils";
import { assistantMessage } from "../testing/test-fixtures";

const generateTextMock = getGenerateTextMock();
const streamTextMock = getStreamTextMock();
const invalidTransportPattern =
  /llmTransport must be 'generate' or 'stream-collect'/;

function mockStreamedResponse(messages: unknown[]): void {
  streamTextMock.mockReturnValue({
    responseMessages: Promise.resolve(messages),
  });
}

function mockStreamedError({
  maskedError,
  originalError,
}: {
  readonly maskedError: Error;
  readonly originalError: unknown;
}): void {
  streamTextMock.mockImplementation(
    ({ onError }: { onError: (event: { error: unknown }) => void }) => {
      onError({ error: originalError });
      return {
        responseMessages: Promise.reject(maskedError),
      };
    }
  );
}

describe("generateModelStep transport", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("GENERATED")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses generateText by default and never touches streamText", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;

    await expect(
      runModelStep(
        { model: fakeModel },
        { history: [{ role: "user", content: "hello" }], signal }
      )
    ).resolves.toEqual([assistantMessage("GENERATED")]);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("uses generateText for the explicit 'generate' transport", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;

    await expect(
      runModelStep(
        { model: fakeModel, transport: "generate" },
        { history: [{ role: "user", content: "hello" }], signal }
      )
    ).resolves.toEqual([assistantMessage("GENERATED")]);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("routes the 'stream-collect' transport through streamText with the same request", async () => {
    const runModelStep = await loadModelStepRunner();
    mockStreamedResponse([assistantMessage("STREAMED")]);
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];

    await expect(
      runModelStep(
        {
          instructions: "test instructions",
          model: fakeModel,
          toolChoice: "auto",
          transport: "stream-collect",
        },
        { history, signal }
      )
    ).resolves.toEqual([assistantMessage("STREAMED")]);

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: signal,
        instructions: "test instructions",
        messages: history,
        model: fakeModel,
        onError: expect.any(Function),
        toolChoice: "auto",
      })
    );
  });

  it("rethrows the original model error instead of streamText's masked rejection", async () => {
    const runModelStep = await loadModelStepRunner();
    const originalError = new Error("upstream provider exploded");
    mockStreamedError({
      maskedError: new Error(
        "No output generated. Check the stream for errors."
      ),
      originalError,
    });

    await expect(
      runModelStep(
        { model: fakeModel, transport: "stream-collect" },
        {
          history: [{ role: "user", content: "hello" }],
          signal: new AbortController().signal,
        }
      )
    ).rejects.toBe(originalError);
  });

  it("surfaces a captured stream error even when responseMessages resolves", async () => {
    const runModelStep = await loadModelStepRunner();
    const originalError = new Error("late stream error");
    streamTextMock.mockImplementation(
      ({ onError }: { onError: (event: { error: unknown }) => void }) => {
        onError({ error: originalError });
        return {
          responseMessages: Promise.resolve([assistantMessage("partial")]),
        };
      }
    );

    await expect(
      runModelStep(
        { model: fakeModel, transport: "stream-collect" },
        {
          history: [{ role: "user", content: "hello" }],
          signal: new AbortController().signal,
        }
      )
    ).rejects.toBe(originalError);
  });

  it("propagates streamText rejections as-is when no stream error was reported", async () => {
    const runModelStep = await loadModelStepRunner();
    const abortError = new Error("aborted");
    streamTextMock.mockReturnValue({
      responseMessages: Promise.reject(abortError),
    });

    await expect(
      runModelStep(
        { model: fakeModel, transport: "stream-collect" },
        {
          history: [{ role: "user", content: "hello" }],
          signal: new AbortController().signal,
        }
      )
    ).rejects.toBe(abortError);
  });
});

describe("Agent llmTransport wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("GENERATED")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps generateText for agents without llmTransport", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({ model: fakeModel });

    await drainRun(await agent.send("default transport"));

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("routes agent turns through streamText for llmTransport 'stream-collect'", async () => {
    const Agent = await loadAgent();
    mockStreamedResponse([assistantMessage("STREAMED")]);
    const agent = new Agent({
      llmTransport: "stream-collect",
      model: fakeModel,
    });

    await drainRun(await agent.send("streamed transport"));

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("rejects invalid llmTransport values", async () => {
    const Agent = await loadAgent();

    expect(
      () =>
        new Agent({
          llmTransport: "collect" as never,
          model: fakeModel,
        })
    ).toThrow(invalidTransportPattern);
  });
});
