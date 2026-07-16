import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type MockLanguageModelV4Options = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV4>[0]
>;
export type MockLanguageModelV4Generate = NonNullable<
  MockLanguageModelV4Options["doGenerate"]
>;
type MockLanguageModelV4GenerateValue = Exclude<
  MockLanguageModelV4Generate,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4GenerateResult = Extract<
  MockLanguageModelV4GenerateValue,
  { readonly content: unknown }
>;
export type MockLanguageModelV4GenerateFunction = Extract<
  MockLanguageModelV4Generate,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4CallOptions =
  Parameters<MockLanguageModelV4GenerateFunction>[0];
type MockLanguageModelV4Stream = NonNullable<
  MockLanguageModelV4Options["doStream"]
>;
type MockLanguageModelV4StreamValue = Exclude<
  MockLanguageModelV4Stream,
  (...args: never[]) => unknown
>;
export type MockLanguageModelV4StreamResult = Extract<
  MockLanguageModelV4StreamValue,
  { readonly stream: unknown }
>;
export type MockLanguageModelV4StreamPart =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const emptyUsage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: undefined,
  },
  outputTokens: {
    reasoning: undefined,
    text: undefined,
    total: undefined,
  },
} satisfies MockLanguageModelV4GenerateResult["usage"];

export function createMockLanguageModelV4(
  results:
    | readonly MockLanguageModelV4GenerateResult[]
    | MockLanguageModelV4GenerateFunction
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: typeof results === "function" ? results : [...results],
  });
}

export function mockLanguageModelV4Text(
  text: string
): MockLanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: emptyUsage,
    warnings: [],
  };
}

export function mockLanguageModelV4ToolCall({
  input,
  toolCallId,
  toolName,
}: {
  input: unknown;
  toolCallId: string;
  toolName: string;
}): MockLanguageModelV4GenerateResult {
  return {
    content: [
      {
        input: JSON.stringify(input),
        toolCallId,
        toolName,
        type: "tool-call",
      },
    ],
    finishReason: { raw: "tool-calls", unified: "tool-calls" },
    usage: emptyUsage,
    warnings: [],
  };
}

export function mockLanguageModelV4Empty(): MockLanguageModelV4GenerateResult {
  return {
    content: [],
    finishReason: { raw: "stop", unified: "stop" },
    usage: emptyUsage,
    warnings: [],
  };
}

export function createStreamingMockLanguageModelV4(
  results:
    | readonly (readonly MockLanguageModelV4StreamPart[])[]
    | ((
        options: MockLanguageModelV4CallOptions
      ) => readonly MockLanguageModelV4StreamPart[])
): MockLanguageModelV4 {
  const streamResult = (
    parts: readonly MockLanguageModelV4StreamPart[]
  ): MockLanguageModelV4StreamResult => ({
    stream: simulateReadableStream({ chunks: [...parts] }),
  });
  return new MockLanguageModelV4({
    doStream:
      typeof results === "function"
        ? (options) => Promise.resolve(streamResult(results(options)))
        : results.map(streamResult),
  });
}

export function mockLanguageModelV4StreamText(
  text: string,
  { id = "text-1" }: { readonly id?: string } = {}
): MockLanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { id, type: "text-start" },
    { delta: text, id, type: "text-delta" },
    { id, type: "text-end" },
    mockLanguageModelV4StreamFinish("stop"),
  ];
}

export function mockLanguageModelV4StreamToolCall({
  input,
  toolCallId,
  toolName,
}: {
  input: unknown;
  toolCallId: string;
  toolName: string;
}): MockLanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      input: JSON.stringify(input),
      toolCallId,
      toolName,
      type: "tool-call",
    },
    mockLanguageModelV4StreamFinish("tool-calls"),
  ];
}

export function mockLanguageModelV4StreamError(
  error: unknown
): MockLanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { error, type: "error" },
  ];
}

function mockLanguageModelV4StreamFinish(
  finishReason: "stop" | "tool-calls"
): MockLanguageModelV4StreamPart {
  return {
    finishReason: { raw: finishReason, unified: finishReason },
    type: "finish",
    usage: emptyUsage,
  };
}
