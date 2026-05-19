import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { Llm } from "./llm";

const fakeModel = {} as LanguageModel;
const fakeLlm: Llm = () => Promise.resolve([]);

const acceptsModelOptions: AgentOptions = {
  instructions: "Use the injected model.",
  model: fakeModel,
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
});
