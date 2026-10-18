import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
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

async function createRunContext(
  runId: string,
  interceptToolResult?: ThreadToolResultInterceptor
): Promise<{
  readonly context: RuntimeToolExecutionContext;
  readonly host: InMemoryHost;
}> {
  const host = createInMemoryHost();
  await host.store.turns.create({
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status: "running",
    threadKey: "thread",
  });
  const context = createThreadToolExecutionContext({
    executionHost: host,
    ...(interceptToolResult ? { interceptToolResult } : {}),
    leaseId: null,
    runId,
    state: new ThreadState({ key: "thread", store: host.store.threads }),
  });
  return { context, host };
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

    // Then: one after-tool checkpoint carries only the transformed output.
    const latest = await host.store.checkpoints.latest(runId);
    expect(latest).toMatchObject({
      phase: "after-tool",
      runtimeState: { output: "REDACTED" },
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

  it("fails recovery closed after concurrent sibling results", async () => {
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
    let modelCalls = 0;
    const agent = await createAgent({
      host,
      model: createCallbackModel(() => {
        modelCalls += 1;
        return Promise.resolve([assistantMessage("UNREACHABLE")]);
      }),
    });

    // When: the thread is continued after the crash.
    const continued = agent.thread("thread").continue();

    // Then: recovery parks the run instead of replaying one tool.
    await expect(continued).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    expect(modelCalls).toBe(0);
    await expect(host.store.turns.get(runId)).resolves.toMatchObject({
      status: "needs-recovery",
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
    let modelCalls = 0;
    const agent = await createAgent({
      host,
      model: createCallbackModel(() => {
        modelCalls += 1;
        return Promise.resolve([assistantMessage("UNREACHABLE")]);
      }),
    });
    await expect(agent.thread("thread").continue()).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    expect(modelCalls).toBe(0);
  });
});
