import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentHost,
  CheckpointStore,
  EventStore,
  HostScheduler,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  StoredThreadEvent,
  ThreadEventLog,
  ThreadEventReadOptions,
  TurnRecord,
  TurnStore,
} from "../execution";
import type {
  AgentAutoCompactionOptions,
  AgentInput,
  AgentOptions,
  HostAttachmentStore,
  ThreadCompactionInput,
  ThreadHandle,
} from "../index";
import {
  Agent,
  runPluginsForEvent,
  threadStoreKey as runtimeThreadStoreKey,
  ThreadEventReplayUnsupportedError,
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
    expect(runtime).not.toHaveProperty("runPluginsForToolCall");
    expect(runtime).toHaveProperty("threadStoreKey", runtimeThreadStoreKey);
    expect(runtime).not.toHaveProperty("createInMemoryHost");
    expect(runtime).not.toHaveProperty("createCloudflareHost");
    expect(runtime).not.toHaveProperty("createCloudflareStorageHost");
    expect(runtime).not.toHaveProperty("createCloudflarePlatformContext");
    expect(runtime).not.toHaveProperty("createCloudflareAgentsHost");
    expect(runtime).not.toHaveProperty("createCloudflarePlatformContext");
    expect(runtime).not.toHaveProperty("createFileHost");
    expect(runtime).not.toHaveProperty("createNodeFileAgentContext");
    expect(runtime).not.toHaveProperty("createFileHost");
    expect(runtime).not.toHaveProperty("FileExecutionStore");
    expect(runtime).not.toHaveProperty("FileThreadStore");
    expect(runtime).not.toHaveProperty("executionHost");
    expect(runtime).not.toHaveProperty("BackgroundScheduler");
    expect(runtime).not.toHaveProperty("ToolExecutionNeedsRecoveryError");
    expect(runtime).not.toHaveProperty(runStreamExport);
    expect(emptyHostIsRejected).toBe(false);
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

  it("types public thread compaction options from the package root", () => {
    const autoCompaction = {
      contextGate: {
        maxInputTokens: 120_000,
        onOverflow: "compact",
      },
      minMessages: 12,
      retainMessages: 4,
    } satisfies AgentAutoCompactionOptions;
    const model = {} as AgentOptions["model"];
    const attachmentStore = {} as HostAttachmentStore;
    const enabledOptions = {
      attachmentStore,
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
    expectTypeOf<Parameters<ThreadHandle["events"]>[0]>().toEqualTypeOf<
      ThreadEventReadOptions | undefined
    >();
    expectTypeOf<ReturnType<ThreadHandle["events"]>>().toEqualTypeOf<
      AsyncIterable<StoredThreadEvent>
    >();
    expect(new ThreadEventReplayUnsupportedError("thread-1").name).toBe(
      "ThreadEventReplayUnsupportedError"
    );
    expectTypeOf<ReturnType<Agent["overlay"]>>().toEqualTypeOf<ThreadHandle>();
    expectTypeOf<
      ReturnType<typeof runtimeThreadStoreKey>
    >().toEqualTypeOf<string>();
    expect(enabledOptions.autoCompaction).toEqual(autoCompaction);
    expect(enabledOptions.attachmentStore).toBe(attachmentStore);
    expect(enabledOptions.notificationOverlays).toEqual(["runtime context"]);
    expect(disabledOptions.autoCompaction).toBe(false);
    expect(compaction.startSeq).toBe(0);
  });

  it("types advanced host contracts", () => {
    expectTypeOf<AgentHost["scheduler"]>().toEqualTypeOf<HostScheduler>();
    expectTypeOf<AgentHost["store"]>().toEqualTypeOf<HostStore>();
    expectTypeOf<
      HostStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<AgentHost["attachmentStore"]>().toEqualTypeOf<
      HostAttachmentStore | undefined
    >();
    expectTypeOf<HostStore["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<HostStore["checkpoints"]>().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<HostStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<HostStore["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<TurnStore["get"]>>
    >().toEqualTypeOf<TurnRecord | null>();
    expectTypeOf<HostStoreTransaction["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      HostStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<HostStoreTransaction["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<AgentHost>().not.toHaveProperty("kind");
  });

  it("exports file thread inspection from the file adapter only", async () => {
    const runtime = await import("../index");
    const fileAdapter = await import("../platform/file");

    expect(runtime).not.toHaveProperty("inspectFileThread");
    expect(runtime).not.toHaveProperty("fileThreadStorageHint");
    expect(fileAdapter).toHaveProperty("inspectFileThread");
    expect(fileAdapter).toHaveProperty("fileThreadStorageHint");
  });
});
