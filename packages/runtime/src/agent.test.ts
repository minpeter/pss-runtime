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

const collectRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  for await (const _event of run.stream()) {
    // Drain the stream so the run can finish.
  }
};

describe("Agent", () => {
  it("keeps AgentOptions type fixtures reachable", () => {
    expect(typeFixtures).toHaveLength(4);
  });

  it("creates agents from a caller-owned LanguageModel", async () => {
    await expect(Agent.create({ model: fakeModel })).resolves.toBeInstanceOf(
      Agent
    );
  });

  it("creates agents from a caller-owned LLM", async () => {
    await expect(Agent.create({ llm: fakeLlm })).resolves.toBeInstanceOf(Agent);
  });

  it("uses the default session for agent.send", async () => {
    const agent = await Agent.create({ llm: fakeLlm });
    await expect(agent.send("hello")).resolves.toBeDefined();
  });

  it("reuses handles for named sessions", async () => {
    const agent = await Agent.create({ llm: fakeLlm });
    expect(agent.session("a")).toBe(agent.session("a"));
    expect(agent.session("a")).not.toBe(agent.session("b"));
  });

  it("drops killed session handles so keys can be reused", async () => {
    const agent = await Agent.create({ llm: fakeLlm });
    const first = agent.session("reuse");

    first.kill();
    const second = agent.session("reuse");
    await collectRun(await second.send("hello"));

    expect(second).not.toBe(first);
  });

  it("rejects missing constructor options with an actionable error", async () => {
    await expect(
      Agent.create(undefined as unknown as AgentOptions)
    ).rejects.toThrow(missingOptionsPattern);
  });

  it("rejects missing model configuration with an actionable error", async () => {
    await expect(Agent.create({} as AgentOptions)).rejects.toThrow(
      missingModelPattern
    );
  });

  it("rejects invalid custom LLM configuration with an actionable error", async () => {
    await expect(
      Agent.create({ llm: "not-an-llm" } as unknown as AgentOptions)
    ).rejects.toThrow(invalidLlmPattern);
  });

  it("rejects ambiguous model and custom LLM configuration", async () => {
    await expect(
      Agent.create({
        llm: fakeLlm,
        model: fakeModel,
      } as unknown as AgentOptions)
    ).rejects.toThrow(ambiguousOptionsPattern);
  });
});
