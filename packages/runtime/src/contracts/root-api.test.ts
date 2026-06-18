import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CheckpointStore,
  DurableBackgroundHost,
  EventStore,
  ExecutionHost,
  ExecutionScheduler,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  RunRecord,
  RunStore,
  SessionHost,
  ThreadHost,
} from "../execution";
import type {
  AgentEvent,
  AgentHost,
  ControlAgentEvent,
  ExpectedSessionVersion,
  ExpectedThreadVersion,
  LifecycleAgentEvent,
  SessionInput,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
  StoredThread,
  TelemetryAgentEvent,
  ThreadInput,
  ThreadStore,
  ThreadStoreCommit,
  VisibleAgentEvent,
} from "../index";
import {
  Agent,
  isControlAgentEvent,
  isLifecycleAgentEvent,
  isTelemetryAgentEvent,
  isVisibleAgentEvent,
  runPluginsForEvent,
} from "../index";

type EmptyHostIsRejected =
  Record<string, never> extends AgentHost ? true : false;
const emptyHostIsRejected: EmptyHostIsRejected = false;
const forbiddenRuntimeSubagentExports = [
  ["Subagent", "Definition"].join(""),
  ["resume", "Background", "Child", "Run"].join(""),
  ["Background", "Child", "Agent"].join(""),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
] as const;
const forbiddenModelAdapterRootExports = [
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
  ["create", "Llm"].join(""),
] as const;

describe("runtime public exports", () => {
  it("does not expose internal agent loop runner from package root", async () => {
    const runtime = await import("../index");

    expect(runtime).not.toHaveProperty("runAgentLoop");
  });

  it("keeps package root app-facing and omits run stream helpers", async () => {
    const runtime = await import("../index");
    const runStreamExport = ["Agent", "Run", "Stream"].join("");

    expect(runtime).toHaveProperty("Agent", Agent);
    expect(runtime).toHaveProperty("runPluginsForEvent", runPluginsForEvent);
    expect(runtime).not.toHaveProperty("createInMemoryExecutionHost");
    expect(runtime).not.toHaveProperty("createCloudflareDurableObjectHost");
    expect(runtime).not.toHaveProperty("executionHost");
    expect(runtime).not.toHaveProperty("BackgroundScheduler");
    expect(runtime).not.toHaveProperty("ToolExecutionNeedsRecoveryError");
    expect(runtime).not.toHaveProperty(runStreamExport);
    expect(emptyHostIsRejected).toBe(false);
  });

  it("exports event classifiers from the package root", async () => {
    const runtime = await import("../index");

    expect(runtime).toHaveProperty("isVisibleAgentEvent", isVisibleAgentEvent);
    expect(runtime).toHaveProperty(
      "isLifecycleAgentEvent",
      isLifecycleAgentEvent
    );
    expect(runtime).toHaveProperty(
      "isTelemetryAgentEvent",
      isTelemetryAgentEvent
    );
    expect(runtime).toHaveProperty("isControlAgentEvent", isControlAgentEvent);
  });

  it("does not expose runtime-owned subagent helpers from the package root", async () => {
    const runtime = await import("../index");

    for (const forbiddenName of forbiddenRuntimeSubagentExports) {
      expect(runtime).not.toHaveProperty(forbiddenName);
    }
  });

  it("does not expose runtime LLM adapter names from the package root", async () => {
    const runtime = await import("../index");

    for (const forbiddenName of forbiddenModelAdapterRootExports) {
      expect(runtime).not.toHaveProperty(forbiddenName);
    }
  });

  it("types event classifier exports from the package root", () => {
    const visible = {
      text: "hello",
      type: "assistant-text",
    } satisfies VisibleAgentEvent;
    const lifecycle = { type: "turn-start" } satisfies LifecycleAgentEvent;
    const telemetry = {
      text: "thinking",
      type: "assistant-reasoning",
    } satisfies TelemetryAgentEvent;
    const control = lifecycle satisfies ControlAgentEvent;
    const events = [visible, lifecycle, telemetry, control] satisfies readonly [
      VisibleAgentEvent,
      LifecycleAgentEvent,
      TelemetryAgentEvent,
      Exclude<AgentEvent, VisibleAgentEvent>,
    ];

    expect(events.map((event) => event.type)).toEqual([
      "assistant-text",
      "turn-start",
      "assistant-reasoning",
      "turn-start",
    ]);
  });

  it("types advanced host contracts", () => {
    expectTypeOf<
      ExecutionHost["scheduler"]
    >().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<ExecutionHost["store"]>().toEqualTypeOf<ExecutionStore>();
    expectTypeOf<
      ExecutionStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<ExecutionHost["kind"]>().toEqualTypeOf<"execution">();
    expectTypeOf<ExecutionStore["runs"]>().toEqualTypeOf<RunStore>();
    expectTypeOf<
      ExecutionStore["checkpoints"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<ExecutionStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<RunStore["get"]>>
    >().toEqualTypeOf<RunRecord | null>();
    expectTypeOf<ExecutionStoreTransaction["runs"]>().toEqualTypeOf<RunStore>();
    expectTypeOf<
      ExecutionStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    const threadHost = {
      kind: "thread",
      threadStore: {} as ThreadHost["threadStore"],
    } satisfies ThreadHost;
    const legacySessionHost = {
      kind: "session",
      threadStore: {} as ThreadHost["threadStore"],
    } satisfies SessionHost;
    const legacySessionStoreHost = {
      kind: "session",
      sessionStore: {} as ThreadHost["threadStore"],
    } satisfies SessionHost;
    const agentHost = threadHost satisfies AgentHost;
    const legacyAgentHost = legacySessionHost satisfies AgentHost;
    const legacySessionStoreAgentHost =
      legacySessionStoreHost satisfies AgentHost;
    expectTypeOf<DurableBackgroundHost["runStore"]>().toEqualTypeOf<RunStore>();
    expectTypeOf<
      DurableBackgroundHost["checkpointStore"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<
      DurableBackgroundHost["eventStore"]
    >().toEqualTypeOf<EventStore>();
    expectTypeOf<
      DurableBackgroundHost["notificationInbox"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<
      DurableBackgroundHost["backgroundScheduler"]
    >().toEqualTypeOf<ExecutionScheduler>();
    expectTypeOf<DurableBackgroundHost["transaction"]>().toEqualTypeOf<
      ExecutionStore["transaction"]
    >();
    expect(agentHost.kind).toBe("thread");
    expect(legacyAgentHost.kind).toBe("session");
    expect(legacySessionStoreAgentHost.kind).toBe("session");
  });

  it("types legacy session aliases from the package root", () => {
    expectTypeOf<SessionInput>().toEqualTypeOf<ThreadInput>();
    expectTypeOf<SessionStore>().toEqualTypeOf<ThreadStore>();
    expectTypeOf<SessionStoreCommit>().toEqualTypeOf<ThreadStoreCommit>();
    expectTypeOf<StoredSession>().toEqualTypeOf<StoredThread>();
    expectTypeOf<ExpectedSessionVersion>().toEqualTypeOf<ExpectedThreadVersion>();
  });

  it("declares thread store package subpaths with legacy adapters", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8"
      )
    ) as {
      exports: Record<string, { "@minpeter/pss-source": string }>;
    };

    expect(packageJson.exports["./thread-store/memory"]).toMatchObject({
      "@minpeter/pss-source": "./src/thread/store/memory.ts",
    });
    expect(packageJson.exports["./thread-store/file"]).toMatchObject({
      "@minpeter/pss-source": "./src/thread/store/file.ts",
    });
    expect(packageJson.exports["./session-store/memory"]).toEqual(
      packageJson.exports["./thread-store/memory"]
    );
    expect(packageJson.exports["./session-store/file"]).toEqual(
      packageJson.exports["./thread-store/file"]
    );
  });
});
