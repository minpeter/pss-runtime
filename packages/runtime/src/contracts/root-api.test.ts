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
  ThreadHost,
  TurnRecord,
  TurnStore,
} from "../execution";
import type {
  AgentAutoCompactionOptions,
  AgentEvent,
  AgentHost,
  AgentInput,
  AgentOptions,
  ControlAgentEvent,
  LifecycleAgentEvent,
  TelemetryAgentEvent,
  ThreadCompactionInput,
  ThreadHandle,
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
    expect(runtime).not.toHaveProperty("createCloudflareAgentContext");
    expect(runtime).not.toHaveProperty("createNodeFileExecutionHost");
    expect(runtime).not.toHaveProperty("createNodeFileAgentContext");
    expect(runtime).not.toHaveProperty("createNodeFileThreadHost");
    expect(runtime).not.toHaveProperty("FileExecutionStore");
    expect(runtime).not.toHaveProperty("FileThreadStore");
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
      type: "assistant-output",
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
      "assistant-output",
      "turn-start",
      "assistant-reasoning",
      "turn-start",
    ]);
  });

  it("types public thread compaction options from the package root", () => {
    const autoCompaction = {
      minMessages: 12,
      retainMessages: 4,
    } satisfies AgentAutoCompactionOptions;
    const model = {} as AgentOptions["model"];
    const enabledOptions = {
      autoCompaction,
      model,
      notificationOverlays: ["runtime context"],
    } satisfies AgentOptions;
    const disabledOptions = {
      autoCompaction: false,
      model,
    } satisfies AgentOptions;
    const compaction = {
      endSeqExclusive: 8,
      startSeq: 0,
      summary: "Earlier turns established the durable context.",
    } satisfies ThreadCompactionInput;

    expectTypeOf<
      Parameters<ThreadHandle["compact"]>[0]
    >().toEqualTypeOf<ThreadCompactionInput>();
    expectTypeOf<
      Parameters<ThreadHandle["overlay"]>[0]
    >().toEqualTypeOf<AgentInput>();
    expectTypeOf<
      ReturnType<ThreadHandle["overlay"]>
    >().toEqualTypeOf<ThreadHandle>();
    expectTypeOf<ReturnType<Agent["overlay"]>>().toEqualTypeOf<ThreadHandle>();
    expect(enabledOptions.autoCompaction).toEqual(autoCompaction);
    expect(enabledOptions.notificationOverlays).toEqual(["runtime context"]);
    expect(disabledOptions.autoCompaction).toBe(false);
    expect(compaction.startSeq).toBe(0);
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
    expectTypeOf<ExecutionStore["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      ExecutionStore["checkpoints"]
    >().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<ExecutionStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<TurnStore["get"]>>
    >().toEqualTypeOf<TurnRecord | null>();
    expectTypeOf<
      ExecutionStoreTransaction["turns"]
    >().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      ExecutionStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    const threadHost = {
      kind: "thread",
      threadStore: {} as ThreadHost["threadStore"],
    } satisfies ThreadHost;
    const agentHost = threadHost satisfies AgentHost;
    expectTypeOf<
      DurableBackgroundHost["turnStore"]
    >().toEqualTypeOf<TurnStore>();
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
  });

  it("declares thread store package subpaths without session aliases", async () => {
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
    expect(packageJson.exports["./session-store/memory"]).toBeUndefined();
    expect(packageJson.exports["./session-store/file"]).toBeUndefined();
  });

  it("declares the Cloudflare adapter as a platform implementation subpath", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8"
      )
    ) as {
      exports: Record<string, { "@minpeter/pss-source": string }>;
    };

    expect(packageJson.exports["./cloudflare"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/cloudflare/index.ts",
      import: "./dist/platform/cloudflare/index.js",
      types: "./dist/platform/cloudflare/index.d.ts",
    });
  });

  it("declares the Node adapter as a platform implementation subpath", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8"
      )
    ) as {
      exports: Record<string, { "@minpeter/pss-source": string }>;
    };

    expect(packageJson.exports["./node"]).toMatchObject({
      "@minpeter/pss-source": "./src/platform/node/index.ts",
      import: "./dist/platform/node/index.js",
      types: "./dist/platform/node/index.d.ts",
    });
  });
});
