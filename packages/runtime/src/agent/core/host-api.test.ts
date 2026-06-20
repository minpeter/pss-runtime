import { describe, expect, it } from "vitest";
import {
  createInMemoryExecutionHost,
  type DurableBackgroundHost,
  type ExecutionHost,
  type ExecutionScheduler,
  type ThreadHost,
} from "../../execution";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "../../thread/handle/test-support";
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
const acceptsThreadHost = {
  kind: "thread",
  threadStore: new SpyStore(),
} satisfies ThreadHost;
const acceptsDurableBackgroundHost = {
  backgroundScheduler: aggregateHost.scheduler,
  checkpointStore: aggregateHost.store.checkpoints,
  eventStore: aggregateHost.store.events,
  kind: "durable-background",
  notificationInbox: aggregateHost.store.notifications,
  turnStore: aggregateHost.store.turns,
  threadStore: aggregateHost.store.threads,
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
type RejectsBareThreadStoreAsHost = AssertFalse<
  IsAssignable<{ readonly threadStore: SpyStore }, AgentHost>
>;
type RejectsExecutionHostThreadStoreKey = AssertFalse<
  IsAssignable<{ readonly threadStore: SpyStore }, ExecutionHost>
>;
type RequiresHostKindKey = "kind" extends keyof AgentHost ? true : false;
type AcceptsThreadHostAsAgentHost = IsAssignable<
  typeof acceptsThreadHost,
  AgentHost
>;
type AcceptsExecutionHostAsAgentHost = IsAssignable<
  typeof aggregateHost,
  AgentHost
>;
type RejectsLegacyKindAsAgentHost = AssertFalse<
  IsAssignable<
    { readonly kind: "legacy"; readonly threadStore: SpyStore },
    AgentHost
  >
>;
type RejectsLegacyStoreOnlyDurableBackgroundHost = AssertFalse<
  IsAssignable<
    {
      readonly backgroundScheduler: typeof aggregateHost.scheduler;
      readonly eventStore: typeof aggregateHost.store.events;
      readonly kind: "durable-background";
      readonly notificationInbox: typeof aggregateHost.store.notifications;
      readonly legacyStore: SpyStore;
      readonly checkpointStore: typeof aggregateHost.store.checkpoints;
      readonly transaction: typeof aggregateHost.store.transaction;
      readonly turnStore: typeof aggregateHost.store.turns;
    },
    AgentHost
  >
>;
type DurableSchedulerMatchesExecutionScheduler = IsAssignable<
  DurableBackgroundHost["backgroundScheduler"],
  ExecutionScheduler
>;

const typeFixtures = [
  acceptsDurableBackgroundHost,
  acceptsHostOptions,
  acceptsThreadHost,
];
const acceptsHostOptionAssertion: AcceptsHostOption = true;
const rejectsRuntimeModelOptionAssertion: AssertFalse<AcceptsRuntimeModelOption> = false;
const llmOptionAssertion: RejectsLlmOptionKey = false;
const runtimeOptionAssertion: RejectsRuntimeOptionKey = false;
const sessionsOptionAssertion: RejectsSessionsOptionKey = false;
const hostThreadStoreAssertion: RejectsBareThreadStoreAsHost = false;
const executionThreadStoreAssertion: RejectsExecutionHostThreadStoreKey = false;
const hostKindAssertion: RequiresHostKindKey = true;
const acceptsThreadHostAssertion: AcceptsThreadHostAsAgentHost = true;
const acceptsExecutionHostAssertion: AcceptsExecutionHostAsAgentHost = true;
const rejectsLegacyKindAssertion: RejectsLegacyKindAsAgentHost = false;
const rejectsLegacyStoreOnlyDurableBackgroundHostAssertion: RejectsLegacyStoreOnlyDurableBackgroundHost = false;
const durableSchedulerAssertion: DurableSchedulerMatchesExecutionScheduler = true;

describe("Agent host public API", () => {
  it("accepts host option and keeps unsupported option keys out of AgentOptions", () => {
    expect(typeFixtures).toHaveLength(3);
    expect(acceptsHostOptionAssertion).toBe(true);
    expect(rejectsRuntimeModelOptionAssertion).toBe(false);
    expect(llmOptionAssertion).toBe(false);
    expect(runtimeOptionAssertion).toBe(false);
    expect(sessionsOptionAssertion).toBe(false);
    expect(hostThreadStoreAssertion).toBe(false);
    expect(executionThreadStoreAssertion).toBe(false);
    expect(hostKindAssertion).toBe(true);
    expect(acceptsThreadHostAssertion).toBe(true);
    expect(acceptsExecutionHostAssertion).toBe(true);
    expect(rejectsLegacyKindAssertion).toBe(false);
    expect(rejectsLegacyStoreOnlyDurableBackgroundHostAssertion).toBe(false);
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

  it("uses host thread store for thread snapshots", async () => {
    const threadStore = new SpyStore();
    const agent = new Agent({
      host: { kind: "thread", threadStore },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.thread("host-owned").send("hello"));

    expect(threadStore.commits.at(-1)?.key).toBe("host-owned");
  });

  it("includes scoped thread addresses in the stored thread key", async () => {
    const threadStore = new SpyStore();
    const agent = new Agent({
      host: { kind: "thread", threadStore },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(
      await agent.thread({ key: "room/1", scope: "user:1" }).send("hello")
    );

    expect(threadStore.commits.at(-1)?.key).toBe(
      "scope:user%3A1:thread:room%2F1"
    );
  });
});
