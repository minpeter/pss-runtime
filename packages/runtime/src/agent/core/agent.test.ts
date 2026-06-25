import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
} from "../../testing/test-fixtures";
import {
  Agent,
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  type AgentOptions,
} from "./agent";
import { threadStoreKey } from "./thread-entry";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);
const functionModel = () => Promise.resolve([]);
const invalidInstrumentationEntryPattern =
  /options\.instrumentations entry must provide wrapTurn/;
const invalidInstrumentationReturnPattern =
  /wrapTurn\(\) must return an AgentTurn/;
const invalidInstrumentationsArrayPattern =
  /options\.instrumentations must be an array/;
const invalidModelPattern = /invalid options\.model/;
const missingModelPattern = /missing options\.model/;
const missingOptionsPattern = /Agent options are required/;
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
  instrumentations: [],
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

  it("does not expose a static factory", () => {
    expect(Object.hasOwn(Agent, "create")).toBe(false);
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

  it("applies agent instrumentations to returned turns", async () => {
    const contexts: AgentInstrumentationContext[] = [];
    const observedTypes: string[] = [];
    const instrumentation: AgentInstrumentation = {
      name: "test",
      wrapTurn: (turn, context) => {
        contexts.push(context);
        return {
          async *events() {
            for await (const event of turn.events()) {
              observedTypes.push(event.type);
              yield event;
            }
          },
        };
      },
    };
    const agent = new Agent({
      instrumentations: [instrumentation],
      model: fakeModel,
      namespace: "tenant",
    });

    await collectRun(await agent.thread("observed").send("hello"));
    await collectRun(await agent.thread("observed").steer("again"));

    expect(contexts).toEqual([
      {
        namespace: "tenant",
        operation: "send",
        threadKey: "observed",
      },
      {
        namespace: "tenant",
        operation: "steer",
        threadKey: "observed",
      },
    ]);
    expect(observedTypes).toContain("assistant-output");
    expect(observedTypes).toContain("turn-end");
  });

  it("applies fresh instrumentation context when live steer returns the active turn", async () => {
    const contexts: AgentInstrumentationContext[] = [];
    const modelGate = createDeferred();
    const instrumentation: AgentInstrumentation = {
      wrapTurn: (turn, context) => {
        contexts.push(context);
        return turn;
      },
    };
    const agent = new Agent({
      instrumentations: [instrumentation],
      model: createCallbackModel(async () => {
        await modelGate.promise;
        return [assistantMessage("DONE")];
      }),
    });
    const thread = agent.thread("active-steer");
    const sendRun = await thread.send("initial");

    await thread.steer("runtime input");
    modelGate.resolve();
    await collectRun(sendRun);

    expect(contexts).toEqual([
      {
        operation: "send",
        threadKey: "active-steer",
      },
      {
        operation: "steer",
        threadKey: "active-steer",
      },
    ]);
  });

  it("snapshots agent instrumentations at construction", async () => {
    const observedNames: string[] = [];
    const instrumentations: AgentInstrumentation[] = [
      {
        name: "initial",
        wrapTurn: (turn) => {
          observedNames.push("initial");
          return turn;
        },
      },
    ];
    const agent = new Agent({ instrumentations, model: fakeModel });

    instrumentations.push({
      name: "late",
      wrapTurn: (turn) => {
        observedNames.push("late");
        return turn;
      },
    });

    await collectRun(await agent.send("hello"));

    expect(observedNames).toEqual(["initial"]);
  });

  it("rejects malformed agent instrumentations with actionable errors", () => {
    expect(() =>
      Reflect.construct(Agent, [
        {
          instrumentations: {},
          model: fakeModel,
        },
      ])
    ).toThrow(invalidInstrumentationsArrayPattern);
    expect(() =>
      Reflect.construct(Agent, [
        {
          instrumentations: [{}],
          model: fakeModel,
        },
      ])
    ).toThrow(invalidInstrumentationEntryPattern);
  });

  it("rejects invalid turns returned by agent instrumentations", async () => {
    const agent = new Agent({
      instrumentations: [
        {
          wrapTurn: () => null as unknown as ReturnType<Agent["send"]>,
        } as unknown as AgentInstrumentation,
      ],
      model: fakeModel,
    });

    await expect(agent.send("hello")).rejects.toThrow(
      invalidInstrumentationReturnPattern
    );
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
