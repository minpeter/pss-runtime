import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import type { RecoveryResolution } from "../../agent/resume/resolve-recovery";
import { RecoveryResolutionError } from "../../agent/resume/resolve-recovery";
import type { AgentHost } from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import { createFileHost } from "../../platform/file";
import { createInMemoryHost } from "../../platform/memory";
import { createCheckpointSpyHost } from "../../testing/execution-checkpoint-test-support";
import { assistantMessage, eventTypes } from "../../testing/test-fixtures";
import { INTERRUPTED_TOOL_CALL_TEXT } from "../runtime/recovered-tool-round";
import {
  callTools,
  committedHistory,
  continueAfterRestart,
  crashDuringTurn,
  drainContinuation,
  effectTool,
  emptyTurn,
  expireLease,
  hangingTool,
  latestRun,
  restartedHost,
  scriptedModel,
  THREAD,
  waitForResult,
} from "./crash-recovery.test-support";
import { collect } from "./test-support";

describe("durable tool recovery policies", () => {
  it("reruns an unfinished idempotent call under its idempotency key", async () => {
    // Given: a step's idempotent call never finished; its sibling did.
    const host = createInMemoryHost();
    const { deploy, sync, tools } = await crashedDeployAndSync(host);

    // When: a restarted process continues the thread.
    const recovered = await continueAfterRestart(host, tools);

    // Then: the call ran once more under the same key before the model ran.
    expect(recovered.history.split("SYNCED")).toHaveLength(2);
    expect(sync.calls).toEqual([
      expect.objectContaining({ attempt: 1, toolCallId: "call_sync" }),
      {
        attempt: 2,
        idempotencyKey: sync.calls[0]?.idempotencyKey,
        toolCallId: "call_sync",
      },
    ]);
    expect(deploy.effects.count).toBe(1);
  });

  it("reports an unfinished interrupt call to the model as interrupted", async () => {
    // Given: a step's interrupt-policy call never finished.
    const host = createInMemoryHost();
    const shell = hangingTool("interrupt");
    const tools = { shell: shell.tool };
    await crashDuringTurn(host, tools, shell.called(), [
      callTools(["call_shell", "shell"]),
    ]);

    // When: a restarted process continues the thread.
    const recovered = await continueAfterRestart(host, tools);

    // Then: the model learns the call was interrupted; it never runs again.
    expect(recovered.events).toContain("turn-end");
    expect(recovered.history).toContain(INTERRUPTED_TOOL_CALL_TEXT);
    expect(shell.calls).toHaveLength(1);
  });

  it("writes no checkpoint of its own for a pure call's intent", async () => {
    // Given: a host that records every checkpoint write.
    const { checkpoints, host } = createCheckpointSpyHost();
    const read = effectTool("FILE_CONTENTS", "pure");
    const agent = await createAgent({
      host,
      model: scriptedModel([callTools(["call_read", "read"])]).model,
      tools: { read: read.tool },
    });

    // When: a step runs one pure call.
    expect(eventTypes(await collect(await agent.send("go")))).toContain(
      "turn-end"
    );

    // Then: only its result was checkpointed.
    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "after-tool",
    ]);
  });

  it("keeps a rerun's result when its process dies before the round commits", async () => {
    // Given: a recovering process reran an unfinished call, journaled the
    // result, and died before committing the round.
    const host = createInMemoryHost();
    const { deploy, sync, tools } = await crashedDeployAndSync(host);
    const dying = await createAgent({
      host: restartedHost(host, () => sync.calls.length > 1),
      model: scriptedModel([]).model,
      tools,
    });
    collect((await dying.thread(THREAD).continue()) ?? emptyTurn()).catch(
      () => undefined
    );
    await waitForResult(host, "call_sync");
    await expireLease(host);

    // When: a third process continues the thread.
    const restarted = await continueAfterRestart(host, tools);

    // Then: the journaled result reaches the model once; nothing reruns.
    expect(restarted.events).toContain("turn-end");
    expect(restarted.history.split("SYNCED")).toHaveLength(2);
    expect(restarted.history.split("DEPLOYED")).toHaveLength(2);
    expect(sync.calls).toHaveLength(2);
    expect(deploy.effects.count).toBe(1);
  });

  it("keeps every unsettled call journaled while recovery settles the first", async () => {
    // Given: a step left two calls unfinished, and the process recovering
    // them died while rerunning the first.
    const host = createInMemoryHost();
    const sync = hangingTool("idempotent", { hangs: 2, output: "SYNCED" });
    const shell = hangingTool("interrupt");
    const tools = { shell: shell.tool, sync: sync.tool };
    await crashDuringTurn(
      host,
      tools,
      Promise.all([sync.called(), shell.called()]).then(() => undefined),
      [callTools(["call_sync", "sync"], ["call_shell", "shell"])]
    );
    const recovering = await createAgent({
      host: restartedHost(host),
      model: scriptedModel([]).model,
      tools,
    });
    collect((await recovering.thread(THREAD).continue()) ?? emptyTurn()).catch(
      () => undefined
    );
    await sync.called(2);
    await expireLease(host);

    // When: a third process continues the thread.
    const restarted = await continueAfterRestart(host, tools);

    // Then: both calls are settled, and the interrupted one never reruns.
    expect(restarted.history.split("SYNCED")).toHaveLength(2);
    expect(restarted.history).toContain(INTERRUPTED_TOOL_CALL_TEXT);
    expect(shell.calls).toHaveLength(1);
    expect(sync.calls).toHaveLength(3);
  });

  it("keeps settled results and reports the rest interrupted when the recovered turn is cancelled", async () => {
    // Given: a crashed step left two calls unfinished; the recovering
    // process reran the first and is stuck rerunning the second.
    const host = createInMemoryHost();
    const sync = hangingTool("idempotent", { output: "SYNCED" });
    const upload = hangingTool("idempotent", { hangs: 2 });
    const tools = { sync: sync.tool, upload: upload.tool };
    await crashDuringTurn(
      host,
      tools,
      Promise.all([sync.called(), upload.called()]).then(() => undefined),
      [callTools(["call_sync", "sync"], ["call_upload", "upload"])]
    );
    const recovering = await createAgent({
      host: restartedHost(host),
      model: scriptedModel([]).model,
      tools,
    });
    const thread = recovering.thread(THREAD);
    const events = collect((await thread.continue()) ?? emptyTurn());
    await upload.called(2);

    // When: the user interrupts the recovered turn.
    thread.interrupt();

    // Then: the cancelled turn committed the finished rerun's result and
    // reports the cut-short call as interrupted.
    expect(eventTypes(await events)).toContain("turn-abort");
    const history = await committedHistory(host);
    expect(history.split("SYNCED")).toHaveLength(2);
    expect(history).toContain(INTERRUPTED_TOOL_CALL_TEXT);
  });
});

describe("agent.resolveRecovery", () => {
  it("reports a parked call as interrupted without running it", async () => {
    // Given: a run parked on an unfinished manual-recovery call.
    const parked = await parkedTransfer();

    // When: the operator interrupts it and the thread continues.
    await parked.agent.resolveRecovery(parked.runId, {
      otherwise: { action: "interrupt" },
    });
    const recovered = await drainContinuation(
      parked.agent,
      parked.model.histories
    );

    // Then: the model learns the call was interrupted; it never runs again.
    expect(recovered.events).toContain("turn-end");
    expect(recovered.history).toContain(INTERRUPTED_TOOL_CALL_TEXT);
    expect(parked.transfer.calls).toHaveLength(1);
  });

  it("gives a parked call the supplied result", async () => {
    // Given: a run parked on an unfinished manual-recovery call.
    const parked = await parkedTransfer();

    // When: the operator supplies the call's result.
    await parked.agent.resolveRecovery(parked.runId, {
      toolCalls: {
        call_transfer: { action: "result", output: "CONFIRMED_BY_OPERATOR" },
      },
    });
    const recovered = await drainContinuation(
      parked.agent,
      parked.model.histories
    );

    // Then: the model receives that result, and the tool never runs again.
    expect(recovered.history.split("CONFIRMED_BY_OPERATOR")).toHaveLength(2);
    expect(parked.transfer.calls).toHaveLength(1);
  });

  it("stores a supplied result without output as null on a file host", async () => {
    // Given: a file-hosted run parked on an unfinished manual-recovery call.
    const directory = await mkdtemp(join(tmpdir(), "pss-resolve-recovery-"));
    try {
      const parked = await parkedTransfer({
        host: createFileHost({ directory }),
      });

      // When: the operator supplies a result without output and resumes.
      await parked.agent.resolveRecovery(parked.runId, {
        toolCalls: { call_transfer: { action: "result", output: undefined } },
      });
      const recovered = await drainContinuation(
        parked.agent,
        parked.model.histories
      );

      // Then: the model receives a null result, and the tool never reruns.
      expect(recovered.events).toContain("turn-end");
      expect(recovered.history).toContain('"value":null');
      expect(parked.transfer.calls).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, maxRetries: 10, recursive: true });
    }
  });

  it("reruns a parked call under its idempotency key on resume", async () => {
    // Given: a run parked on an unfinished manual-recovery call.
    const parked = await parkedTransfer();

    // When: the operator decides to rerun it and resumes the run.
    await parked.agent.resolveRecovery(parked.runId, {
      otherwise: { action: "rerun" },
    });
    const turn = await parked.agent.resume(parked.runId);

    // Then: it runs once more under the same key before the model runs.
    expect(eventTypes(await collect(turn ?? emptyTurn()))).toContain(
      "turn-end"
    );
    expect(parked.model.histories[0]?.split("TRANSFERRED")).toHaveLength(2);
    expect(parked.transfer.calls[1]).toEqual({
      attempt: 2,
      idempotencyKey: parked.transfer.calls[0]?.idempotencyKey,
      toolCallId: "call_transfer",
    });
  });

  it("parks again when a decided rerun is cut short by another crash", async () => {
    // Given: a decided rerun whose process also died mid-call.
    const parked = await parkedTransfer({ hangs: 2 });
    await parked.agent.resolveRecovery(parked.runId, {
      otherwise: { action: "rerun" },
    });
    const rerun = await parked.agent.thread(THREAD).continue();
    collect(rerun ?? emptyTurn()).catch(() => undefined);
    await parked.transfer.called(2);
    await expireLease(parked.host);

    // When: a third process continues the thread.
    const restarted = await createAgent({
      host: restartedHost(parked.host),
      model: scriptedModel([]).model,
      tools: parked.tools,
    });

    // Then: the decision was spent, so the run waits for a new one.
    await expect(restarted.thread(THREAD).continue()).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    expect(await latestRun(parked.host)).toMatchObject({
      status: "needs-recovery",
    });
    expect(parked.transfer.calls).toHaveLength(2);
  });

  it("rejects a run that is not parked", async () => {
    // Given: a run that completed.
    const host = createInMemoryHost();
    const agent = await createAgent({
      host,
      model: scriptedModel([]).model,
    });
    await collect(await agent.thread(THREAD).send("go"));
    const { runId } = await latestRun(host);

    // When / Then: there is nothing to resolve.
    await expect(agent.resolveRecovery(runId)).rejects.toMatchObject({
      reason: "not-parked",
      runId,
    });
  });

  it.each([
    [{}, "undecided", ["call_transfer"]],
    [
      { toolCalls: { call_missing: { action: "interrupt" } } },
      "unknown-tool-call",
      ["call_missing"],
    ],
  ] satisfies readonly (readonly [RecoveryResolution, string, string[]])[])(
    "records nothing when the decisions are %j",
    async (resolution, reason, toolCallIds) => {
      // Given: a run parked on an unfinished manual-recovery call.
      const parked = await parkedTransfer();
      const before = await latestRun(parked.host);

      // When: the decisions do not cover exactly its unfinished calls.
      const resolved = parked.agent.resolveRecovery(parked.runId, resolution);

      // Then: it is rejected and the run is unchanged.
      await expect(resolved).rejects.toBeInstanceOf(RecoveryResolutionError);
      await expect(resolved).rejects.toMatchObject({ reason, toolCallIds });
      expect(await latestRun(parked.host)).toEqual(before);
    }
  );

  it("keeps the turn's input and finished rounds when a hook parks a call", async () => {
    // Given: a hook parked step 2's call after step 1's tool ran.
    const host = createInMemoryHost();
    const lookup = effectTool("LOOKUP_RESULT");
    const deploy = effectTool("DEPLOYED");
    const tools = { deploy: deploy.tool, lookup: lookup.tool };
    const parking = await createAgent({
      hooks: parkDeploy,
      host,
      model: scriptedModel([
        callTools(["call_lookup", "lookup"]),
        callTools(["call_deploy", "deploy"]),
      ]).model,
      tools,
    });
    await collect(await parking.thread(THREAD).send("go"));
    const { runId } = await latestRun(host);
    const committed = await committedHistory(host);

    // When: a restarted process records a result and resumes the run.
    const model = scriptedModel([
      () => Promise.resolve([assistantMessage("DONE")]),
    ]);
    const agent = await createAgent({
      host: restartedHost(host),
      model: model.model,
      tools,
    });
    await agent.resolveRecovery(runId, {
      toolCalls: {
        call_deploy: { action: "result", output: "DEPLOYED_BY_HAND" },
      },
    });
    const resumed = await agent.resume(runId);
    const events = eventTypes(await collect(resumed ?? emptyTurn()));

    // Then: the park kept the input and step 1's round, and the run finishes
    // with both results without running either tool again.
    expect(committed).toContain('"content":"go"');
    expect(committed).toContain("LOOKUP_RESULT");
    expect(events).toContain("turn-end");
    expect(model.histories[0]).toContain("LOOKUP_RESULT");
    expect(model.histories[0]).toContain("DEPLOYED_BY_HAND");
    expect(lookup.effects.count).toBe(1);
    expect(deploy.effects.count).toBe(0);
    expect(await latestRun(host)).toMatchObject({ status: "completed" });
  });

  it("resumes a hook-parked run in the same process once it is decided", async () => {
    // Given: a hook parked the turn's only call in this process.
    const host = createInMemoryHost();
    const deploy = effectTool("DEPLOYED");
    const agent = await createAgent({
      hooks: parkDeploy,
      host,
      model: scriptedModel([
        callTools(["call_deploy", "deploy"]),
        () => Promise.resolve([assistantMessage("DONE")]),
      ]).model,
      tools: { deploy: deploy.tool },
    });
    await collect(await agent.thread(THREAD).send("go"));
    const { runId } = await latestRun(host);

    // When: the same process records a decision and resumes the run.
    await agent.resolveRecovery(runId, { otherwise: { action: "interrupt" } });
    const resumed = await agent.resume(runId);

    // Then: the run finishes; the parked call never ran.
    expect(eventTypes(await collect(resumed ?? emptyTurn()))).toContain(
      "turn-end"
    );
    expect(await latestRun(host)).toMatchObject({ status: "completed" });
    expect(deploy.effects.count).toBe(0);
  });
});

/** A run parked on its unfinished manual-recovery `transfer` call. */
async function parkedTransfer({
  hangs = 1,
  host = createInMemoryHost() as AgentHost,
} = {}) {
  const transfer = hangingTool("manual-recovery", {
    hangs,
    output: "TRANSFERRED",
  });
  const tools = { transfer: transfer.tool };
  await crashDuringTurn(host, tools, transfer.called(), [
    callTools(["call_transfer", "transfer"]),
  ]);
  const model = scriptedModel([]);
  const agent = await createAgent({
    host: restartedHost(host),
    model: model.model,
    tools,
  });
  await expect(agent.thread(THREAD).continue()).rejects.toBeInstanceOf(
    ToolExecutionNeedsRecoveryError
  );
  const { runId } = await latestRun(host);
  return { agent, host, model, runId, tools, transfer };
}

/** Hooks that park every `deploy` call before it runs. */
const parkDeploy: AgentHooks = {
  beforeToolExecution: (event) =>
    event.toolName === "deploy" ? { status: "needs-recovery" } : undefined,
};

/** A crashed step whose `deploy` call finished and `sync` call never did. */
async function crashedDeployAndSync(host: AgentHost) {
  const deploy = effectTool("DEPLOYED");
  const sync = hangingTool("idempotent", { output: "SYNCED" });
  const tools = { deploy: deploy.tool, sync: sync.tool };
  await crashDuringTurn(
    host,
    tools,
    sync.called(),
    [callTools(["call_deploy", "deploy"], ["call_sync", "sync"])],
    1
  );
  return { deploy, sync, tools };
}
