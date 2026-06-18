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
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "./mock-language-model-v4-test-utils";
import { collect, SpyStore } from "./session/session.test-support";
import { assistantMessage, createCallbackModel } from "./test-fixtures";

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
  checkpointStore: aggregateHost.store.checkpoints,
  eventStore: aggregateHost.store.events,
  kind: "durable-background",
  notificationInbox: aggregateHost.store.notifications,
  runStore: aggregateHost.store.runs,
  sessionStore: aggregateHost.store.sessions,
  transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
} satisfies DurableBackgroundHost;
const acceptsDurableNotificationResumeHost = {
  backgroundScheduler: aggregateHost.scheduler,
  checkpointStore: aggregateHost.store.checkpoints,
  kind: "durable-notification-resume",
  notificationInbox: aggregateHost.store.notifications,
  runStore: aggregateHost.store.runs,
  transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
} satisfies DurableNotificationResumeHost;

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
const rejectsRuntimeModelOptionAssertion: AssertFalse<AcceptsRuntimeModelOption> = false;
const llmOptionAssertion: RejectsLlmOptionKey = false;
const runtimeOptionAssertion: RejectsRuntimeOptionKey = false;
const sessionsOptionAssertion: RejectsSessionsOptionKey = false;
const hostSessionStoreAssertion: RejectsBareSessionStoreAsHost = false;
const executionSessionStoreAssertion: RejectsExecutionHostSessionStoreKey = false;
const hostKindAssertion: RequiresHostKindKey = true;
const acceptsSessionHostAssertion: AcceptsSessionHostAsAgentHost = true;
const acceptsExecutionHostAssertion: AcceptsExecutionHostAsAgentHost = true;
const backgroundSchedulerAssertion: BackgroundSchedulerMatchesExecutionScheduler = true;
const executionSchedulerAssertion: ExecutionSchedulerMatchesBackgroundScheduler = true;

describe("Agent host public API", () => {
  it("accepts host option and keeps unsupported option keys out of AgentOptions", () => {
    expect(typeFixtures).toHaveLength(10);
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
    expect(backgroundSchedulerAssertion).toBe(true);
    expect(executionSchedulerAssertion).toBe(true);
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

  it("uses host session store for session snapshots", async () => {
    const sessionStore = new SpyStore();
    const agent = new Agent({
      host: { kind: "session", sessionStore },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.session("host-owned").send("hello"));

    expect(sessionStore.commits.at(-1)?.key).toBe("host-owned");
  });
});
