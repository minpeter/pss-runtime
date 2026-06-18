import { describe, expect, it } from "vitest";
import {
  createInMemoryExecutionHost,
  type DurableBackgroundHost,
  type ExecutionHost,
  type ExecutionScheduler,
  type SessionHost,
} from "../../execution";
import { collect, SpyStore } from "../../session/handle/test-support";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { Agent, type AgentHost, type AgentOptions } from "./agent";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

const inProcessHost = createInMemoryExecutionHost() satisfies AgentHost;

const acceptsHostOptions: AgentOptions = {
  host: inProcessHost,
  model: fakeModel,
};
const runtimeModel = () => Promise.resolve([assistantMessage("RUNTIME MODEL")]);
const functionModelOptions = {
  model: runtimeModel,
} as const;
const aggregateHost = createInMemoryExecutionHost();
const acceptsSessionHost = {
  kind: "session",
  sessionStore: new SpyStore(),
} satisfies SessionHost;
const acceptsDurableBackgroundHost = {
  backgroundScheduler: aggregateHost.scheduler,
  checkpointStore: aggregateHost.store.checkpoints,
  eventStore: aggregateHost.store.events,
  kind: "durable-background",
  notificationInbox: aggregateHost.store.notifications,
  runStore: aggregateHost.store.runs,
  sessionStore: aggregateHost.store.sessions,
  transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
} satisfies DurableBackgroundHost;

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type AssertFalse<T extends false> = T;
type AcceptsHostOption = IsAssignable<typeof acceptsHostOptions, AgentOptions>;
type AcceptsRuntimeModelOption = IsAssignable<
  typeof functionModelOptions,
  AgentOptions
>;
type RejectsLlmOptionKey = AssertFalse<
  "llm" extends keyof AgentOptions ? true : false
>;
type RejectsRuntimeOptionKey = AssertFalse<
  "runtime" extends keyof AgentOptions ? true : false
>;
type RejectsSessionsOptionKey = AssertFalse<
  "sessions" extends keyof AgentOptions ? true : false
>;
type RejectsBareSessionStoreAsHost = AssertFalse<
  IsAssignable<{ readonly sessionStore: SpyStore }, AgentHost>
>;
type RejectsExecutionHostSessionStoreKey = AssertFalse<
  IsAssignable<{ readonly sessionStore: SpyStore }, ExecutionHost>
>;
type RequiresHostKindKey = "kind" extends keyof AgentHost ? true : false;
type AcceptsSessionHostAsAgentHost = IsAssignable<
  typeof acceptsSessionHost,
  AgentHost
>;
type AcceptsExecutionHostAsAgentHost = IsAssignable<
  typeof aggregateHost,
  AgentHost
>;
type DurableSchedulerMatchesExecutionScheduler = IsAssignable<
  DurableBackgroundHost["backgroundScheduler"],
  ExecutionScheduler
>;

const typeFixtures = [
  acceptsDurableBackgroundHost,
  acceptsHostOptions,
  acceptsSessionHost,
];
const acceptsHostOptionAssertion: AcceptsHostOption = true;
const rejectsRuntimeModelOptionAssertion: AssertFalse<AcceptsRuntimeModelOption> = false;
const llmOptionAssertion: RejectsLlmOptionKey = false;
const runtimeOptionAssertion: RejectsRuntimeOptionKey = false;
const sessionsOptionAssertion: RejectsSessionsOptionKey = false;
const hostSessionStoreAssertion: RejectsBareSessionStoreAsHost = false;
const executionSessionStoreAssertion: RejectsExecutionHostSessionStoreKey = false;
const hostKindAssertion: RequiresHostKindKey = true;
const acceptsSessionHostAssertion: AcceptsSessionHostAsAgentHost = true;
const acceptsExecutionHostAssertion: AcceptsExecutionHostAsAgentHost = true;
const durableSchedulerAssertion: DurableSchedulerMatchesExecutionScheduler = true;

describe("Agent host public API", () => {
  it("accepts host option and keeps unsupported option keys out of AgentOptions", () => {
    expect(typeFixtures).toHaveLength(3);
    expect(acceptsHostOptionAssertion).toBe(true);
    expect(rejectsRuntimeModelOptionAssertion).toBe(false);
    expect(llmOptionAssertion).toBe(false);
    expect(runtimeOptionAssertion).toBe(false);
    expect(sessionsOptionAssertion).toBe(false);
    expect(hostSessionStoreAssertion).toBe(false);
    expect(executionSessionStoreAssertion).toBe(false);
    expect(hostKindAssertion).toBe(true);
    expect(acceptsSessionHostAssertion).toBe(true);
    expect(acceptsExecutionHostAssertion).toBe(true);
    expect(durableSchedulerAssertion).toBe(true);
    expect(new Agent({ host: inProcessHost, model: fakeModel })).toBeInstanceOf(
      Agent
    );
  });

  it("rejects custom runtime model functions through model", () => {
    expect(() => Reflect.construct(Agent, [functionModelOptions])).toThrow(
      "Agent: invalid options.model"
    );
  });

  it("does not implement legacy llm sessions and runtime options", () => {
    expect(() =>
      Reflect.construct(Agent, [
        {
          llm: () => Promise.resolve([assistantMessage("DONE")]),
        },
      ])
    ).toThrow("Agent: missing options.model");

    expect(() =>
      Reflect.construct(Agent, [
        {
          model: runtimeModel,
          sessions: { store: new SpyStore() },
        },
      ])
    ).toThrow("Agent: invalid options.model");

    expect(() =>
      Reflect.construct(Agent, [
        {
          model: runtimeModel,
          runtime: {},
        },
      ])
    ).toThrow("Agent: invalid options.model");
  });

  it("uses host session store for thread snapshots", async () => {
    const sessionStore = new SpyStore();
    const agent = new Agent({
      host: { kind: "session", sessionStore },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.thread("host-owned").send("hello"));

    expect(sessionStore.commits.at(-1)?.key).toBe("host-owned");
  });

  it("includes scoped thread addresses in the stored thread key", async () => {
    const sessionStore = new SpyStore();
    const agent = new Agent({
      host: { kind: "session", sessionStore },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(
      await agent.thread({ key: "room/1", scope: "user:1" }).send("hello")
    );

    expect(sessionStore.commits.at(-1)?.key).toBe(
      "scope:user%3A1:thread:room%2F1"
    );
  });
});
