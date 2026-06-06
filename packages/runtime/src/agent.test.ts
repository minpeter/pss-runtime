import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { RuntimeLlm } from "./llm";

const fakeModel = {} as LanguageModel;
const fakeLlm: RuntimeLlm = () => Promise.resolve([]);
const ambiguousOptionsPattern = /either options\.llm or options\.model/;
const invalidLlmPattern = /invalid options\.llm/;
const missingModelPattern = /missing options\.model/;
const missingOptionsPattern = /Agent options are required/;
const duplicateSubagentToolNamePattern = /duplicate subagent tool name/;
const existingToolCollisionPattern = /collides with an existing tool/;
const objectMapSubagentsPattern = /subagents must be an array/;
const reservedToolCollisionPattern = /collides with a reserved subagent tool/;
const subagentMetadataPattern = /subagents\[0\].name/;
const subagentNameLengthPattern = /too long/;
const subagentsOnCustomLlmPattern = /subagents require options.model/;
const legacyLifecyclePattern = /unsupported legacy lifecycle option/;
const legacyLifecycleKey = ["h", "o", "o", "k", "s"].join("");

const acceptsModelOptions: AgentOptions = {
  instructions: "Use the injected model.",
  model: fakeModel,
  plugins: [],
  toolChoice: "auto",
  tools: {},
};
const acceptsCustomLlmOptions: AgentOptions = { llm: fakeLlm, plugins: [] };
const acceptsModelSubagentsOptions: AgentOptions = {
  model: fakeModel,
  subagents: [
    new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "researcher",
    }),
  ],
};

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type AssertFalse<T extends false> = T;
type RejectsAmbiguousModelPrecedence = AssertFalse<
  IsAssignable<
    { readonly llm: RuntimeLlm; readonly model: LanguageModel },
    AgentOptions
  >
>;
type RejectsIgnoredCreateLlmOptions = AssertFalse<
  IsAssignable<
    { readonly llm: RuntimeLlm; readonly tools: Record<PropertyKey, never> },
    AgentOptions
  >
>;
type LegacyLifecycleKey = `${"h"}${"o"}${"o"}${"k"}${"s"}`;
type RejectsLegacyLifecycleOptionKey = AssertFalse<
  LegacyLifecycleKey extends keyof AgentOptions ? true : false
>;

const typeFixtures = [
  acceptsModelOptions,
  acceptsCustomLlmOptions,
  acceptsModelSubagentsOptions,
];
type TypeFixtureAssertions = [
  RejectsAmbiguousModelPrecedence,
  RejectsIgnoredCreateLlmOptions,
  RejectsLegacyLifecycleOptionKey,
];
const typeFixtureAssertions: TypeFixtureAssertions = [false, false, false];

const collectRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  for await (const _event of run.events()) {
    // Drain the events so the run can finish.
  }
};

describe("Agent", () => {
  it("keeps AgentOptions type fixtures reachable", () => {
    expect(typeFixtures).toHaveLength(3);
    expect(typeFixtureAssertions).toHaveLength(3);
  });

  it("constructs agents with new Agent", () => {
    expect(new Agent({ model: fakeModel })).toBeInstanceOf(Agent);
  });

  it("does not expose Agent.create", () => {
    expect(Object.hasOwn(Agent, "create")).toBe(false);
  });

  it("creates agents from a caller-owned LLM", () => {
    expect(new Agent({ llm: fakeLlm })).toBeInstanceOf(Agent);
  });

  it("uses the default session for agent.send", async () => {
    const agent = new Agent({ llm: fakeLlm });
    await expect(agent.send("hello")).resolves.toBeDefined();
  });

  it("reuses handles for named sessions", () => {
    const agent = new Agent({ llm: fakeLlm });
    expect(agent.session("a")).toBe(agent.session("a"));
    expect(agent.session("a")).not.toBe(agent.session("b"));
  });

  it("drops killed session handles so keys can be reused", async () => {
    const agent = new Agent({ llm: fakeLlm });
    const first = agent.session("reuse");

    first.kill();
    const second = agent.session("reuse");
    await collectRun(await second.send("hello"));

    expect(second).not.toBe(first);
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

  it("rejects legacy lifecycle constructor options", () => {
    expect(
      () =>
        new Agent({
          [legacyLifecycleKey]: {},
          llm: fakeLlm,
        } as unknown as AgentOptions)
    ).toThrow(legacyLifecyclePattern);
  });

  it("rejects ambiguous model and custom LLM configuration", () => {
    expect(
      () =>
        new Agent({
          llm: fakeLlm,
          model: fakeModel,
        } as unknown as AgentOptions)
    ).toThrow(ambiguousOptionsPattern);
  });

  it("accepts array subagents with child metadata while main metadata is omitted", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "researcher",
    });

    expect(
      new Agent({
        model: fakeModel,
        subagents: [researcher],
      })
    ).toBeInstanceOf(Agent);
  });

  it("rejects object-map subagents", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "researcher",
    });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: { researcher },
        } as unknown as AgentOptions)
    ).toThrow(objectMapSubagentsPattern);
  });

  it("requires child subagent metadata", () => {
    const unnamed = new Agent({ llm: fakeLlm });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [unnamed],
        })
    ).toThrow(subagentMetadataPattern);
  });

  it("rejects subagent names that exceed generated tool name limits", () => {
    const longName = `a${"b".repeat(52)}`;
    const researcher = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: longName,
    });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [researcher],
        })
    ).toThrow(subagentNameLengthPattern);
  });

  it("rejects subagents on custom llm parents", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "researcher",
    });

    expect(
      () =>
        new Agent({
          llm: fakeLlm,
          subagents: [researcher],
        } as unknown as AgentOptions)
    ).toThrow(subagentsOnCustomLlmPattern);
  });

  it("rejects duplicate normalized subagent names", () => {
    const one = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "research-agent",
    });
    const two = new Agent({
      description: "Researches facts again.",
      llm: fakeLlm,
      name: "research_agent",
    });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [one, two],
        })
    ).toThrow(duplicateSubagentToolNamePattern);
  });

  it("rejects generated tool collisions", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "researcher",
    });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [researcher],
          tools: { delegate_to_researcher: {} },
        } as unknown as AgentOptions)
    ).toThrow(existingToolCollisionPattern);
  });

  it("rejects reserved background tool collisions", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      llm: fakeLlm,
      name: "researcher",
    });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [researcher],
          tools: { background_output: {} },
        } as unknown as AgentOptions)
    ).toThrow(reservedToolCollisionPattern);
  });
});
