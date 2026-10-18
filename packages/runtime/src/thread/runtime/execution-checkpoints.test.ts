import { describe, expect, it } from "vitest";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
} from "../../llm/tool-execution-types";
import { createInMemoryHost } from "../../platform/memory";
import type { InMemoryHost } from "../../platform/memory/execution/execution-host";
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
});
