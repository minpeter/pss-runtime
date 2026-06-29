import type { AgentOptions } from "@minpeter/pss-runtime";

type ScriptedModel = Extract<
  NonNullable<AgentOptions["model"]>,
  { readonly specificationVersion: "v4" }
>;
export type ScriptedResult = Awaited<ReturnType<ScriptedModel["doGenerate"]>>;

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
    content: [{ text, type: "text" }],
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
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
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
): ScriptedModel {
  const scriptedResults = [...results];
  const model = {
    doGenerate: (_options) => {
      const result = scriptedResults.shift();
      if (!result) {
        throw new ScriptedModelError("No scripted model result remains.");
      }
      return Promise.resolve(result);
    },
    doStream: () =>
      Promise.reject(
        new ScriptedModelError("Scripted eval model does not stream.")
      ),
    modelId: "worker-agent-scripted-eval",
    provider: "worker-agent-eval",
    specificationVersion: "v4",
    supportedUrls: {},
  } satisfies ScriptedModel;
  return model;
}

class ScriptedModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptedModelError";
  }
}
