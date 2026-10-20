import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
} from "../../llm/tool-execution-types";
import { createInMemoryHost } from "../../platform/memory";
import type { InMemoryHost } from "../../platform/memory/execution/execution-host";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { encodeThreadSnapshot } from "../state/snapshot";
import { ThreadState } from "../state/thread-state";
import {
  createThreadToolExecutionContext,
  type ThreadToolResultInterceptor,
} from "./execution-checkpoints";

interface RunContext {
  readonly context: RuntimeToolExecutionContext;
  readonly host: InMemoryHost;
  readonly state: ThreadState;
}

async function createRunContext(
  runId: string,
  interceptToolResult?: ThreadToolResultInterceptor
): Promise<RunContext> {
  const host = createInMemoryHost();
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status: "running",
    threadKey: "thread",
  });
  const state = new ThreadState({ key: "thread", store: host.store.threads });
  const context = createThreadToolExecutionContext({
    executionHost: host,
    ...(interceptToolResult ? { interceptToolResult } : {}),
    leaseId: null,
    runId,
    state,
  });
  return { context, host, state };
}

function toolCall(
  runId: string,
  toolCallId: string,
  toolName: string
): RuntimeToolExecutionCheckpoint {
  return {
    attempt: 1,
    idempotencyKey: `${runId}:${toolCallId}`,
    input: {},
    policy: "idempotent",
    toolCallId,
    toolName,
  };
}

async function completeTool(
  context: RuntimeToolExecutionContext,
  checkpoint: RuntimeToolExecutionCheckpoint,
  output: unknown
): Promise<void> {
  await context.beforeTool?.(checkpoint);
  await context.afterTool?.({ ...checkpoint, output });
}

describe("thread tool execution checkpoints", () => {
  it("records tool calls completed earlier in the run on every tool checkpoint", async () => {
    // Given: a run that already completed a deploy tool.
    const runId = "prior-completed";
    const { context, host } = await createRunContext(runId);
    await completeTool(context, toolCall(runId, "call-deploy", "deploy"), "ok");

    // When: a second tool starts.
    await context.beforeTool?.(toolCall(runId, "call-verify", "verify"));

    // Then: its checkpoint names the earlier completed tool call.
    const latest = await host.store.checkpoints.latest(runId);
    expect(latest).toMatchObject({
      phase: "before-tool",
      runtimeState: {
        priorCompletedToolCalls: [
          { toolCallId: "call-deploy", toolName: "deploy" },
        ],
        toolCallId: "call-verify",
      },
    });
  });

  it("seeds earlier completed tools from the run's latest checkpoint after recovery", async () => {
    // Given: an earlier attempt completed deploy before the process died.
    const runId = "prior-completed-recovered";
    const { context: first, host } = await createRunContext(runId);
    await completeTool(first, toolCall(runId, "call-deploy", "deploy"), "ok");

    // When: a recovered attempt for the same run starts another tool.
    const recovered = createThreadToolExecutionContext({
      executionHost: host,
      leaseId: null,
      runId,
      state: new ThreadState({ key: "thread", store: host.store.threads }),
    });
    await recovered.beforeTool?.(toolCall(runId, "call-verify", "verify"));

    // Then: the earlier attempt's completed tool is still recorded.
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      runtimeState: {
        priorCompletedToolCalls: [
          { toolCallId: "call-deploy", toolName: "deploy" },
        ],
      },
    });
  });

  it("persists only the transformed tool result after the result hook", async () => {
    // Given: a result hook that redacts the raw tool output.
    const runId = "redacted-result";
    const { context, host } = await createRunContext(runId, () => ({
      output: "REDACTED",
    }));

    // When: the tool completes.
    await completeTool(
      context,
      toolCall(runId, "call-secret", "secret"),
      "RAW_SECRET"
    );

    // Then: one after-tool checkpoint journals only the transformed output.
    const latest = await host.store.checkpoints.latest(runId);
    expect(latest).toMatchObject({
      phase: "after-tool",
      runtimeState: { results: [{ output: "REDACTED" }] },
      version: 2,
    });
    expect(JSON.stringify(latest)).not.toContain("RAW_SECRET");
  });

  it("leaves the before-tool checkpoint latest when the result hook throws", async () => {
    // Given: a result hook that fails while transforming the raw output.
    const runId = "result-hook-crash";
    const { context, host } = await createRunContext(runId, () => {
      throw new Error("hook crashed");
    });
    const checkpoint = toolCall(runId, "call-secret", "secret");
    await context.beforeTool?.(checkpoint);

    // When: the tool result reaches the failing hook.
    await expect(
      context.afterTool?.({ ...checkpoint, output: "RAW_SECRET" })
    ).rejects.toThrow("hook crashed");

    // Then: the raw output was never persisted for recovery replay.
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      phase: "before-tool",
      version: 1,
    });
  });

  it("lists a concurrently completed sibling on the latest checkpoint", async () => {
    // Given: two parallel tool calls of one step have both started.
    const runId = "parallel-siblings";
    const { context, host } = await createRunContext(runId);
    const first = toolCall(runId, "call-deploy", "deploy");
    const second = toolCall(runId, "call-notify", "notify");
    await context.beforeTool?.(first);
    await context.beforeTool?.(second);

    // When: both results are checkpointed concurrently.
    await Promise.all([
      context.afterTool?.({ ...first, output: "deployed" }),
      context.afterTool?.({ ...second, output: "notified" }),
    ]);

    // Then: the latest checkpoint records the sibling as completed.
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      runtimeState: {
        priorCompletedToolCalls: [
          { toolCallId: "call-deploy", toolName: "deploy" },
        ],
        toolCallId: "call-notify",
      },
      version: 4,
    });
  });

  it("restores concurrent sibling results after a crash", async () => {
    // Given: a crashed run whose two parallel tool results were checkpointed
    // concurrently but never committed to thread history.
    const runId = "parallel-siblings-recovery";
    const { context, host } = await createRunContext(runId);
    await host.store.threads.commit(
      "thread",
      { state: encodeThreadSnapshot([{ content: "go", role: "user" }]) },
      { expectedVersion: null }
    );
    const first = toolCall(runId, "call-deploy", "deploy");
    const second = toolCall(runId, "call-notify", "notify");
    await context.beforeTool?.(first);
    await context.beforeTool?.(second);
    await Promise.all([
      context.afterTool?.({ ...first, output: "deployed" }),
      context.afterTool?.({ ...second, output: "notified" }),
    ]);

    // When: the thread is continued after the crash.
    const history = await continueRecordingHistory(host);

    // Then: both results reach the model exactly once and the run completes.
    expect(history.split("deployed")).toHaveLength(2);
    expect(history.split("notified")).toHaveLength(2);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("keeps checkpointing after an earlier append fails", async () => {
    // Given: a run whose next checkpoint read fails once.
    const runId = "append-failure";
    const { context, host } = await createRunContext(runId);
    const get = host.store.turns.get.bind(host.store.turns);
    vi.spyOn(host.store.turns, "get")
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockImplementation(get);

    // When: one append fails and a later one is issued.
    await expect(
      context.beforeTool?.(toolCall(runId, "call-a", "a"))
    ).rejects.toThrow("transient read failure");
    await context.beforeTool?.(toolCall(runId, "call-b", "b"));

    // Then: the later append is persisted.
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      runtimeState: { toolCallId: "call-b" },
      version: 1,
    });
  });

  it("keeps an earlier completion when a later step reuses its tool call id", async () => {
    // Given: step 1 completed provider call call_0, and step 2 reuses call_0.
    const runId = "reused-tool-call-id";
    const { context, host } = await createRunContext(runId);
    await host.store.threads.commit(
      "thread",
      { state: encodeThreadSnapshot([{ content: "go", role: "user" }]) },
      { expectedVersion: null }
    );
    const reused = toolCall(runId, "call_0", "deploy");
    await completeTool(context, reused, "deployed");

    // When: step 2's tool starts and the process crashes before its result.
    await context.beforeTool?.(reused);

    // Then: the step-1 completion is still recorded on the latest checkpoint.
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      phase: "before-tool",
      runtimeState: {
        priorCompletedToolCalls: [
          { checkpointVersion: 2, toolCallId: "call_0", toolName: "deploy" },
        ],
      },
    });
    // And: recovery restores the journaled step-1 result once.
    const history = await continueRecordingHistory(host);
    expect(history.split("deployed")).toHaveLength(2);
  });

  it("records same-id results already in history on each after-tool checkpoint", async () => {
    // Given: history holds one earlier result for provider id call_0.
    const runId = "result-count";
    const { context, host, state } = await createRunContext(runId);
    await state.ensureLoaded();
    appendToolStep(state, "call_0", "deploy", "EARLIER");

    // When: a later call_0 result is checkpointed.
    await completeTool(context, toolCall(runId, "call_0", "deploy"), "LATER");

    // Then: the checkpoint records the one earlier same-id result.
    await expect(host.store.checkpoints.latest(runId)).resolves.toMatchObject({
      phase: "after-tool",
      runtimeState: { priorResultCount: 1, toolCallId: "call_0" },
    });
  });

  it("restores both results when a background compaction committed an earlier step mid-step", async () => {
    // Given: step 1's call_0 result reached history at step end, and a
    // background compaction committed it while step 2's call_0 ran.
    const runId = "mid-step-compaction-committed";
    const { context, host, state } = await commitLoadedThread(runId);
    const reused = toolCall(runId, "call_0", "deploy");
    await completeTool(context, reused, "STEP1_RESULT");
    appendToolStep(state, "call_0", "deploy", "STEP1_RESULT");
    await expect(state.compact(compactFirstMessage)).resolves.toBe(true);
    await completeTool(context, reused, "STEP2_RESULT");

    // When: the process crashes and the thread is continued.
    const history = await continueRecordingHistory(host);

    // Then: each result reaches the model exactly once.
    expect(history.split("STEP1_RESULT")).toHaveLength(2);
    expect(history.split("STEP2_RESULT")).toHaveLength(2);
  });

  it("restores a reused-id result whose step a background compaction committed around", async () => {
    // Given: a previous turn committed call_0; this turn's call_0 completed,
    // and a background compaction committed before step end appended it.
    const runId = "mid-step-compaction-uncommitted";
    const { context, host, state } = await commitLoadedThread(runId);
    appendToolStep(state, "call_0", "lookup", "OLD_RESULT");
    await state.commit();
    const reused = toolCall(runId, "call_0", "deploy");
    await completeTool(context, reused, "DEPLOYED");
    await expect(state.compact(compactFirstMessage)).resolves.toBe(true);
    appendToolStep(state, "call_0", "deploy", "DEPLOYED");
    await context.beforeTool?.(toolCall(runId, "call_1", "verify"));

    // When: the process crashes and the thread is continued.
    const history = await continueRecordingHistory(host);

    // Then: the journaled result reaches the model once, beside the old one.
    expect(history.split("DEPLOYED")).toHaveLength(2);
    expect(history.split("OLD_RESULT")).toHaveLength(2);
  });
});

const compactFirstMessage = {
  endSeqExclusive: 1,
  startSeq: 0,
  summary: "earlier conversation",
};

async function commitLoadedThread(runId: string): Promise<RunContext> {
  const run = await createRunContext(runId);
  await run.host.store.threads.commit(
    "thread",
    { state: encodeThreadSnapshot([{ content: "go", role: "user" }]) },
    { expectedVersion: null }
  );
  await run.state.ensureLoaded();
  return run;
}

function appendToolStep(
  state: ThreadState,
  toolCallId: string,
  toolName: string,
  value: string
): void {
  state.history.appendModelMessage({
    content: [{ input: {}, toolCallId, toolName, type: "tool-call" }],
    role: "assistant",
  });
  state.history.appendModelMessage({
    content: [
      {
        output: { type: "text", value },
        toolCallId,
        toolName,
        type: "tool-result",
      },
    ],
    role: "tool",
  });
}

/** Continues the crashed thread; returns the history the model received. */
async function continueRecordingHistory(host: InMemoryHost): Promise<string> {
  const histories: string[] = [];
  const agent = await createAgent({
    host,
    model: createCallbackModel(({ history }) => {
      histories.push(JSON.stringify(history));
      return Promise.resolve([assistantMessage("RECOVERED")]);
    }),
  });
  const turn = await agent.thread("thread").continue();
  if (!turn) {
    throw new Error("Expected the crashed run to continue.");
  }
  for await (const _event of turn.events()) {
    // Drain the recovered turn.
  }
  return histories[0] ?? "";
}
