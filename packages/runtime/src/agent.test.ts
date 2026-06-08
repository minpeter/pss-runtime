import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { RuntimeLlm } from "./llm";

const fakeModel = {} as LanguageModel;
const fakeRuntimeModel: RuntimeLlm = () => Promise.resolve([]);
const invalidModelPattern = /invalid options\.model/;
const missingModelPattern = /missing options\.model/;
const missingOptionsPattern = /Agent options are required/;
const unsupportedLlmPattern = /unsupported options\.llm/;
const duplicateSubagentToolNamePattern = /duplicate subagent tool name/;
const existingToolCollisionPattern = /collides with an existing tool/;
const objectMapSubagentsPattern = /subagents must be an array/;
const reservedToolCollisionPattern = /collides with a reserved subagent tool/;
const subagentMetadataPattern = /subagents\[0\].name/;
const subagentNameLengthPattern = /too long/;
const subagentsOnRuntimeModelPattern = /subagents require an AI SDK model/;

const acceptsModelOptions: AgentOptions = {
  instructions: "Use the injected model.",
  model: fakeModel,
  plugins: [],
  toolChoice: "auto",
  tools: {},
};
const acceptsRuntimeModelOptions: AgentOptions = {
  model: fakeRuntimeModel,
  plugins: [],
};
const acceptsModelSubagentsOptions: AgentOptions = {
  model: fakeModel,
  subagents: [
    new Agent({
      description: "Researches facts.",
      model: fakeRuntimeModel,
      name: "researcher",
    }),
  ],
};

type AssertFalse<T extends false> = T;
type RejectsLlmOptionKey = AssertFalse<
  "llm" extends keyof AgentOptions ? true : false
>;
const typeFixtures = [
  acceptsModelOptions,
  acceptsRuntimeModelOptions,
  acceptsModelSubagentsOptions,
];
type TypeFixtureAssertions = [RejectsLlmOptionKey];
const typeFixtureAssertions: TypeFixtureAssertions = [false];

const collectRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  for await (const _event of run.events()) {
    // Drain the events so the run can finish.
  }
};

describe("Agent", () => {
  it("keeps AgentOptions type fixtures reachable", () => {
    expect(typeFixtures).toHaveLength(3);
    expect(typeFixtureAssertions).toHaveLength(1);
  });

  it("constructs agents with new Agent", () => {
    expect(new Agent({ model: fakeModel })).toBeInstanceOf(Agent);
  });

  it("does not expose a static factory", () => {
    expect(Object.hasOwn(Agent, "create")).toBe(false);
  });

  it("creates agents from a caller-owned runtime model", () => {
    expect(new Agent({ model: fakeRuntimeModel })).toBeInstanceOf(Agent);
  });

  it("uses the default session for agent.send", async () => {
    const agent = new Agent({ model: fakeRuntimeModel });
    await expect(agent.send("hello")).resolves.toBeDefined();
  });

  it("reuses handles for named sessions", () => {
    const agent = new Agent({ model: fakeRuntimeModel });
    expect(agent.session("a")).toBe(agent.session("a"));
    expect(agent.session("a")).not.toBe(agent.session("b"));
  });

  it("drops killed session handles so keys can be reused", async () => {
    const agent = new Agent({ model: fakeRuntimeModel });
    const first = agent.session("reuse");

    await first.kill();
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

  it("rejects invalid model configuration with an actionable error", () => {
    expect(
      () => new Agent({ model: "not-a-model" } as unknown as AgentOptions)
    ).toThrow(invalidModelPattern);
  });

  it("rejects unsupported llm configuration with an actionable error", () => {
    expect(
      () =>
        new Agent({
          llm: fakeRuntimeModel,
          model: fakeModel,
        } as unknown as AgentOptions)
    ).toThrow(unsupportedLlmPattern);
  });

  it("accepts array subagents with child metadata while main metadata is omitted", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      model: fakeRuntimeModel,
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
      model: fakeRuntimeModel,
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
    const unnamed = new Agent({ model: fakeRuntimeModel });

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
      model: fakeRuntimeModel,
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

  it("rejects subagents on runtime model parents", () => {
    const researcher = new Agent({
      description: "Researches facts.",
      model: fakeRuntimeModel,
      name: "researcher",
    });

    expect(
      () =>
        new Agent({
          model: fakeRuntimeModel,
          subagents: [researcher],
        } as unknown as AgentOptions)
    ).toThrow(subagentsOnRuntimeModelPattern);
  });

  it("rejects duplicate normalized subagent names", () => {
    const one = new Agent({
      description: "Researches facts.",
      model: fakeRuntimeModel,
      name: "research-agent",
    });
    const two = new Agent({
      description: "Researches facts again.",
      model: fakeRuntimeModel,
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
      model: fakeRuntimeModel,
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
      model: fakeRuntimeModel,
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
