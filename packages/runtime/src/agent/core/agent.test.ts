import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createNoopTool } from "../../testing/llm-test-utils";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { Agent, type AgentOptions, createAgent } from "./agent";
import { threadStoreKey } from "./thread-entry";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);
const functionModel = () => Promise.resolve([]);
const invalidModelPattern = /invalid options\.model/;
const missingModelPattern = /missing options\.model/;
const missingOptionsPattern = /Agent options are required/;
const unsupportedApprovalPattern = /needsApproval.*not supported/;
const agentOptionsSourceUrl = new URL("./options.ts", import.meta.url);
const agentSourceUrl = new URL("./agent.ts", import.meta.url);
const forbiddenAgentSubagentSurface = [
  ["Subagent", "Definition"].join(""),
  ["sub", "agents"].join(""),
  ["create", "Subagent", "Tools"].join(""),
  ["register", "Subagents"].join(""),
  ["subagent", "Count"].join(""),
  ["supports", "Background", "Subagents"].join(""),
] as const;

const acceptsModelOptions: AgentOptions = {
  instructions: "Use the injected model.",
  model: fakeModel,
  plugins: [],
  toolChoice: "auto",
  tools: {},
};
const functionModelOptions = {
  model: functionModel,
  plugins: [],
} as const;

type AssertFalse<T extends false> = T;
type IsAssignable<Source, Target> = Source extends Target ? true : false;
type RejectsDescriptionOptionKey = AssertFalse<
  "description" extends keyof AgentOptions ? true : false
>;
type RejectsLlmOptionKey = AssertFalse<
  "llm" extends keyof AgentOptions ? true : false
>;
type RejectsFunctionModel = AssertFalse<
  IsAssignable<typeof functionModelOptions, AgentOptions>
>;
type RejectsSessionMethod = AssertFalse<
  "session" extends keyof Agent ? true : false
>;
const typeFixtures = [acceptsModelOptions, functionModelOptions];
type TypeFixtureAssertions = [
  RejectsDescriptionOptionKey,
  RejectsLlmOptionKey,
  RejectsFunctionModel,
  RejectsSessionMethod,
];
const typeFixtureAssertions: TypeFixtureAssertions = [
  false,
  false,
  false,
  false,
];

const collectRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  for await (const _event of run.events()) {
    // Drain the events so the run can finish.
  }
};

describe("Agent", () => {
  it("keeps AgentOptions type fixtures reachable", () => {
    expect(typeFixtures).toHaveLength(2);
    expect(typeFixtureAssertions).toHaveLength(4);
  });

  it("constructs agents with new Agent", () => {
    expect(new Agent({ model: fakeModel })).toBeInstanceOf(Agent);
  });

  it("exposes an async factory for plugin initialization", async () => {
    await expect(createAgent({ model: fakeModel })).resolves.toBeInstanceOf(
      Agent
    );
  });

  it("does not expose legacy agent description metadata", () => {
    const agent = Reflect.construct(Agent, [
      {
        description: "reader",
        model: fakeModel,
      },
    ]);

    expect("description" in agent).toBe(false);
  });

  it("rejects caller-owned runtime model functions", () => {
    expect(() => Reflect.construct(Agent, [functionModelOptions])).toThrow(
      invalidModelPattern
    );
  });

  it("omits runtime-owned subagent options and generated tool injection", async () => {
    const source = [
      await readFile(agentOptionsSourceUrl, "utf8"),
      await readFile(agentSourceUrl, "utf8"),
    ].join("\n");

    for (const forbiddenName of forbiddenAgentSubagentSurface) {
      expect(source).not.toContain(forbiddenName);
    }
  });

  it("uses the default thread for agent.send", async () => {
    const agent = new Agent({ model: fakeModel });
    await expect(agent.send("hello")).resolves.toBeDefined();
  });

  it("reuses handles for named threads", () => {
    const agent = new Agent({ model: fakeModel });
    expect(agent.thread("a")).toBe(agent.thread("a"));
    expect(agent.thread("a")).not.toBe(agent.thread("b"));
  });

  it("reuses scoped thread handles by their canonical address", () => {
    const agent = new Agent({ model: fakeModel });

    expect(agent.thread({ key: "a", scope: "user:1" })).toBe(
      agent.thread({ key: "a", scope: "user:1" })
    );
    expect(agent.thread({ key: "a", scope: "user:1" })).not.toBe(
      agent.thread({ key: "a", scope: "user:2" })
    );
  });

  it("exposes the stable thread-store key for host-level adapters", () => {
    expect(threadStoreKey("plain")).toBe("plain");
    expect(threadStoreKey({ key: "room/1", scope: "user:1" })).toBe(
      "scope:user%3A1:thread:room%2F1"
    );
  });

  it("drops disposed thread handles so keys can be reused", async () => {
    const agent = new Agent({ model: fakeModel });
    const first = agent.thread("reuse");

    await first.dispose();
    const second = agent.thread("reuse");
    await collectRun(await second.send("hello"));

    expect(second).not.toBe(first);
  });

  it("rejects missing constructor options with an actionable error", () => {
    expect(() => Reflect.construct(Agent, [undefined])).toThrow(
      missingOptionsPattern
    );
  });

  it("rejects missing model configuration with an actionable error", () => {
    expect(() => new Agent({} as AgentOptions)).toThrow(missingModelPattern);
  });

  it("rejects invalid model configuration with an actionable error", () => {
    expect(() => Reflect.construct(Agent, [{ model: "not-a-model" }])).toThrow(
      invalidModelPattern
    );
  });

  it("rejects tools using AI SDK tool approval", () => {
    const tools = {
      risky: {
        ...createNoopTool(),
        needsApproval: true,
      },
    } satisfies NonNullable<AgentOptions["tools"]>;

    expect(
      () =>
        new Agent({
          model: fakeModel,
          tools,
        })
    ).toThrow(unsupportedApprovalPattern);
  });

  it("does not implement legacy llm configuration", () => {
    expect(() =>
      Reflect.construct(Agent, [
        {
          llm: functionModel,
        },
      ])
    ).toThrow(missingModelPattern);
  });

  it("does not accept legacy option fields by relying on runtime model functions", () => {
    expect(() =>
      Reflect.construct(Agent, [
        {
          model: functionModel,
          name: "coordinator",
          runtime: {},
          sessions: {},
        },
      ])
    ).toThrow(invalidModelPattern);
  });
});
