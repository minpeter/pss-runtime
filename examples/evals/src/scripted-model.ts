// A scripted language model lets evals run deterministically with no API key.
// Each model call pops the next scripted result; for a tool call the real agent
// loop executes the tool, then asks the model again (so a tool-call followed by
// a text result produces one full turn). This mirrors the `ai/test` mock shape.
import { MockLanguageModelV4 } from "ai/test";

type MockOptions = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV4>[0]
>;
type MockGenerate = NonNullable<MockOptions["doGenerate"]>;
type MockGenerateValue = Exclude<MockGenerate, (...args: never[]) => unknown>;
export type ScriptedResult = Extract<
  MockGenerateValue,
  { readonly content: unknown }
>;

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
} satisfies ScriptedResult["usage"];

export function scriptedText(text: string): ScriptedResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: emptyUsage,
    warnings: [],
  };
}

export function scriptedToolCall({
  input,
  toolCallId,
  toolName,
}: {
  input: unknown;
  toolCallId: string;
  toolName: string;
}): ScriptedResult {
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

export function createScriptedModel(
  results: readonly ScriptedResult[]
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: [...results] });
}
