import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentHost, type AgentOptions } from "./agent";
import {
  type BackgroundScheduler,
  type BackgroundSchedulerHost,
  type CheckpointHost,
  createInMemoryExecutionHost,
  type DurableBackgroundHost,
  type DurableNotificationResumeHost,
  type EventHost,
  type ExecutionHost,
  type ExecutionScheduler,
  type ExecutionTransactionHost,
  type NotificationHost,
  type RunHost,
  type SessionHost,
} from "./execution";
import type { RuntimeLlm } from "./llm";
import { collect, SpyStore } from "./session/session.test-support";
import { assistantMessage, eventTypes } from "./test-fixtures";

const fakeModel = {} as LanguageModel;

const inProcessHost = {} satisfies AgentHost;

const acceptsHostOptions: AgentOptions = {
  host: inProcessHost,
  model: fakeModel,
};
const runtimeModel: RuntimeLlm = () =>
  Promise.resolve([assistantMessage("RUNTIME MODEL")]);
const acceptsRuntimeModelOptions: AgentOptions = {
  model: runtimeModel,
};
const aggregateHost = createInMemoryExecutionHost();
const acceptsSessionHost = {
  sessionStore: new SpyStore(),
} satisfies SessionHost;
const acceptsRunHost = {
  runStore: aggregateHost.store.runs,
} satisfies RunHost;
const acceptsCheckpointHost = {
  checkpointStore: aggregateHost.store.checkpoints,
} satisfies CheckpointHost;
const acceptsEventHost = {
  eventStore: aggregateHost.store.events,
} satisfies EventHost;
const acceptsNotificationHost = {
  notificationInbox: aggregateHost.store.notifications,
} satisfies NotificationHost;
const acceptsSchedulerHost = {
  backgroundScheduler: aggregateHost.scheduler,
} satisfies BackgroundSchedulerHost;
const acceptsTransactionHost = {
  transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
} satisfies ExecutionTransactionHost;
const acceptsDurableBackgroundHost = {
  backgroundScheduler: aggregateHost.scheduler,
  capabilities: {},
  checkpointStore: aggregateHost.store.checkpoints,
  eventStore: aggregateHost.store.events,
  notificationInbox: aggregateHost.store.notifications,
  runStore: aggregateHost.store.runs,
  sessionStore: aggregateHost.store.sessions,
  transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
} satisfies DurableBackgroundHost;
const acceptsDurableNotificationResumeHost = {
  backgroundScheduler: aggregateHost.scheduler,
  capabilities: {},
  checkpointStore: aggregateHost.store.checkpoints,
  notificationInbox: aggregateHost.store.notifications,
  runStore: aggregateHost.store.runs,
  transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
} satisfies DurableNotificationResumeHost;

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type AssertFalse<T extends false> = T;
type AcceptsHostOption = IsAssignable<typeof acceptsHostOptions, AgentOptions>;
type AcceptsRuntimeModelOption = IsAssignable<
  typeof acceptsRuntimeModelOptions,
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
type AcceptsHostSessionStoreKey = IsAssignable<
  { readonly sessionStore: SpyStore },
  AgentHost
>;
type RejectsExecutionHostSessionStoreKey = AssertFalse<
  IsAssignable<{ readonly sessionStore: SpyStore }, ExecutionHost>
>;
type RejectsHostKindKey = AssertFalse<
  "kind" extends keyof AgentHost ? true : false
>;
type AcceptsSessionHostAsAgentHost = IsAssignable<
  typeof acceptsSessionHost,
  AgentHost
>;
type AcceptsExecutionHostAsAgentHost = IsAssignable<
  typeof aggregateHost,
  AgentHost
>;
type BackgroundSchedulerMatchesExecutionScheduler = IsAssignable<
  BackgroundScheduler,
  ExecutionScheduler
>;
type ExecutionSchedulerMatchesBackgroundScheduler = IsAssignable<
  ExecutionScheduler,
  BackgroundScheduler
>;

const typeFixtures = [
  acceptsCheckpointHost,
  acceptsDurableBackgroundHost,
  acceptsDurableNotificationResumeHost,
  acceptsEventHost,
  acceptsHostOptions,
  acceptsNotificationHost,
  acceptsRunHost,
  acceptsSchedulerHost,
  acceptsSessionHost,
  acceptsTransactionHost,
];
const acceptsHostOptionAssertion: AcceptsHostOption = true;
const acceptsRuntimeModelOptionAssertion: AcceptsRuntimeModelOption = true;
const llmOptionAssertion: RejectsLlmOptionKey = false;
const runtimeOptionAssertion: RejectsRuntimeOptionKey = false;
const sessionsOptionAssertion: RejectsSessionsOptionKey = false;
const hostSessionStoreAssertion: AcceptsHostSessionStoreKey = true;
const executionSessionStoreAssertion: RejectsExecutionHostSessionStoreKey = false;
const hostKindAssertion: RejectsHostKindKey = false;
const acceptsSessionHostAssertion: AcceptsSessionHostAsAgentHost = true;
const acceptsExecutionHostAssertion: AcceptsExecutionHostAsAgentHost = true;
const backgroundSchedulerAssertion: BackgroundSchedulerMatchesExecutionScheduler = true;
const executionSchedulerAssertion: ExecutionSchedulerMatchesBackgroundScheduler = true;

describe("Agent host public API", () => {
  it("accepts host option and keeps unsupported option keys out of AgentOptions", () => {
    expect(typeFixtures).toHaveLength(10);
    expect(acceptsHostOptionAssertion).toBe(true);
    expect(acceptsRuntimeModelOptionAssertion).toBe(true);
    expect(llmOptionAssertion).toBe(false);
    expect(runtimeOptionAssertion).toBe(false);
    expect(sessionsOptionAssertion).toBe(false);
    expect(hostSessionStoreAssertion).toBe(true);
    expect(executionSessionStoreAssertion).toBe(false);
    expect(hostKindAssertion).toBe(false);
    expect(acceptsSessionHostAssertion).toBe(true);
    expect(acceptsExecutionHostAssertion).toBe(true);
    expect(backgroundSchedulerAssertion).toBe(true);
    expect(executionSchedulerAssertion).toBe(true);
    expect(new Agent({ host: inProcessHost, model: fakeModel })).toBeInstanceOf(
      Agent
    );
  });

  it("accepts custom runtime model functions through model", async () => {
    const seenHistories: unknown[] = [];
    const agent = new Agent({
      model: ({ history }) => {
        seenHistories.push(history);
        return Promise.resolve([assistantMessage("CUSTOM MODEL DONE")]);
      },
    });

    const events = await collect(
      await agent.session("runtime-model").send("hello")
    );

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual({
      text: "CUSTOM MODEL DONE",
      type: "assistant-text",
    });
    expect(JSON.stringify(seenHistories)).toContain("hello");
  });

  it("does not implement legacy llm sessions and runtime options", () => {
    expect(
      () =>
        new Agent({
          llm: () => Promise.resolve([assistantMessage("DONE")]),
        } as unknown as AgentOptions)
    ).toThrow("Agent: missing options.model");

    expect(
      new Agent({
        model: () => Promise.resolve([assistantMessage("DONE")]),
        sessions: { store: new SpyStore() },
      } as unknown as AgentOptions)
    ).toBeInstanceOf(Agent);

    expect(
      new Agent({
        model: () => Promise.resolve([assistantMessage("DONE")]),
        runtime: {},
      } as unknown as AgentOptions)
    ).toBeInstanceOf(Agent);
  });

  it("uses host session store for session snapshots", async () => {
    const sessionStore = new SpyStore();
    const agent = new Agent({
      host: { sessionStore },
      model: () => Promise.resolve([assistantMessage("DONE")]),
    });

    await collect(await agent.session("host-owned").send("hello"));

    expect(sessionStore.commits.at(-1)?.key).toBe("host-owned");
  });
});
