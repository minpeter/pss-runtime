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
