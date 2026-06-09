import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { RuntimeLlm } from "./llm";
import { researcherSubagent } from "./test-fixtures";

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
const subagentFlatFieldPattern = /must be set on the nested agent/;
const subagentNameLengthPattern = /too long/;
const subagentsOnRuntimeModelPattern = /subagents require an AI SDK model/;
const subagentUnwrappedPattern =
  /SubagentDefinition wrappers with an agent field, not raw Agent instances/;
const nestedAgentNameForbiddenPattern = /must not set name/;
const nestedAgentNamespaceRequiredPattern = /agent\.namespace is required/;

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
  subagents: [researcherSubagent({ model: fakeRuntimeModel })],
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
    expect(
      new Agent({
        model: fakeModel,
        subagents: [researcherSubagent({ model: fakeRuntimeModel })],
      })
    ).toBeInstanceOf(Agent);
  });

  it("rejects object-map subagents", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: { researcher: researcherSubagent() },
        } as unknown as AgentOptions)
    ).toThrow(objectMapSubagentsPattern);
  });

  it("rejects unwrapped Agent instances in subagents", () => {
    const child = new Agent({
      description: "Researches facts.",
      instructions: "Research facts.",
      model: fakeModel,
      namespace: "researcher",
    });

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [child],
        } as unknown as AgentOptions)
    ).toThrow(subagentUnwrappedPattern);
  });

  it("requires child subagent metadata", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [
            {
              agent: new Agent({
                instructions: "Research facts.",
                model: fakeModel,
                namespace: "researcher",
              }),
              description: "Researches facts.",
              name: "",
            },
          ],
        })
    ).toThrow(subagentMetadataPattern);
  });

  it("rejects flat instructions on the wrapper", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [
            {
              agent: new Agent({
                instructions: "Research facts.",
                model: fakeModel,
                namespace: "researcher",
              }),
              description: "Researches facts.",
              instructions: "Research facts.",
              name: "researcher",
            },
          ],
        } as unknown as AgentOptions)
    ).toThrow(subagentFlatFieldPattern);
  });

  it("rejects nested agent name", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [
            {
              agent: new Agent({
                instructions: "Research facts.",
                model: fakeModel,
                name: "researcher",
                namespace: "researcher",
              }),
              description: "Researches facts.",
              name: "researcher",
            },
          ],
        })
    ).toThrow(nestedAgentNameForbiddenPattern);
  });

  it("requires nested agent namespace", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [
            {
              agent: new Agent({
                instructions: "Research facts.",
                model: fakeModel,
              }),
              description: "Researches facts.",
              name: "researcher",
            },
          ],
        })
    ).toThrow(nestedAgentNamespaceRequiredPattern);
  });

  it("rejects subagent names that exceed generated tool name limits", () => {
    const longName = `a${"b".repeat(52)}`;

    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [researcherSubagent({ name: longName })],
        })
    ).toThrow(subagentNameLengthPattern);
  });

  it("rejects subagents on runtime model parents", () => {
    expect(
      () =>
        new Agent({
          model: fakeRuntimeModel,
          subagents: [researcherSubagent()],
        } as unknown as AgentOptions)
    ).toThrow(subagentsOnRuntimeModelPattern);
  });

  it("rejects duplicate normalized subagent names", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [
            researcherSubagent({ name: "research-agent" }),
            researcherSubagent({
              description: "Researches facts again.",
              name: "research_agent",
            }),
          ],
        })
    ).toThrow(duplicateSubagentToolNamePattern);
  });

  it("rejects generated tool collisions", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [researcherSubagent()],
          tools: { delegate_to_researcher: {} },
        } as unknown as AgentOptions)
    ).toThrow(existingToolCollisionPattern);
  });

  it("rejects reserved background tool collisions", () => {
    expect(
      () =>
        new Agent({
          model: fakeModel,
          subagents: [researcherSubagent()],
          tools: { background_output: {} },
        } as unknown as AgentOptions)
    ).toThrow(reservedToolCollisionPattern);
  });
});