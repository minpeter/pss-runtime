import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { Llm } from "./llm";

const fakeModel = {} as LanguageModel;
const fakeLlm: Llm = () => Promise.resolve([]);
const ambiguousOptionsPattern = /either options\.llm or options\.model/;
const invalidLlmPattern = /invalid options\.llm/;
const missingModelPattern = /missing options\.model/;
const missingOptionsPattern = /Agent options are required/;

const acceptsModelOptions: AgentOptions = {
  instructions: "Use the injected model.",
  model: fakeModel,
  providerOptions: { openaiCompatible: { reasoningEffort: "low" } },
  tools: {},
};
const acceptsCustomLlmOptions: AgentOptions = { llm: fakeLlm };

// @ts-expect-error custom llm and model options are mutually exclusive.
const rejectsAmbiguousModelPrecedence: AgentOptions = {
  llm: fakeLlm,
  model: fakeModel,
};

// @ts-expect-error custom llm bypasses createLlm-only options such as tools.
const rejectsIgnoredCreateLlmOptions: AgentOptions = {
  llm: fakeLlm,
  providerOptions: {},
  tools: {},
};

const typeFixtures = [
  acceptsModelOptions,
  acceptsCustomLlmOptions,
  rejectsAmbiguousModelPrecedence,
  rejectsIgnoredCreateLlmOptions,
];

describe("Agent", () => {
  it("keeps AgentOptions type fixtures reachable", () => {
    expect(typeFixtures).toHaveLength(4);
  });

  it("creates sessions from a caller-owned LanguageModel", () => {
    expect(new Agent({ model: fakeModel }).createSession()).toBeDefined();
  });

  it("creates sessions from a caller-owned LLM", () => {
    expect(new Agent({ llm: fakeLlm }).createSession()).toBeDefined();
  });

  it("rejects missing constructor options with an actionable error", () => {
    expect(() => new Agent(undefined as unknown as AgentOptions)).toThrow(
      missingOptionsPattern
    );
  });

  it("rejects missing model configuration with an actionable error", () => {
    expect(() => new Agent({} as AgentOptions)).toThrow(missingModelPattern);
  });

  it("rejects invalid custom LLM configuration with an actionable error", () => {
    expect(
      () => new Agent({ llm: "not-an-llm" } as unknown as AgentOptions)
    ).toThrow(invalidLlmPattern);
  });

  it("rejects ambiguous model and custom LLM configuration", () => {
    expect(
      () =>
        new Agent({ llm: fakeLlm, model: fakeModel } as unknown as AgentOptions)
    ).toThrow(ambiguousOptionsPattern);
  });
});
