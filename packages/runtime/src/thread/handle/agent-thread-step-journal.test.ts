import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { deferred } from "../../internal/deferred";
import type { ModelStepOutput } from "../../llm/model-step-types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import { createInMemoryHost } from "../../platform/memory";
import { checkpointedTool } from "../../testing/execution-checkpoint-test-support";
import { assistantMessage, eventTypes } from "../../testing/test-fixtures";
import {
  callTools,
  committedHistory,
  continueAfterRestart,
  crashDuringTurn,
  effectTool,
  emptyTurn,
  expireLease,
  hangingTool,
  latestRun,
  never,
  restartedHost,
  scriptedModel,
  THREAD,
} from "./crash-recovery.test-support";
import { collect } from "./test-support";

describe("durable step journal", () => {
  it("commits each finished tool round before the next model request", async () => {
    // Given: step 1 calls a tool; step 2's model request is held open.
    const host = createInMemoryHost();
    const lookup = effectTool("LOOKUP_RESULT");
    const secondRequest = deferred<void>();
    const release = deferred<ModelStepOutput>();
    const { model } = scriptedModel([
      callTools(["call_lookup", "lookup"]),
      () => {
        secondRequest.resolve();
        return release.promise;
      },
    ]);
    const agent = await createAgent({
      host,
      model,
      tools: { lookup: lookup.tool },
    });

    // When: the turn reaches the second model request.
    const turn = await agent.thread(THREAD).send("go");
    const events = collect(turn);
    await secondRequest.promise;

    // Then: the tool round is already in committed history.
    expect(await committedHistory(host)).toContain("LOOKUP_RESULT");
    release.resolve([assistantMessage("DONE")]);
    expect(eventTypes(await events)).toContain("turn-end");
  });

  it("resumes after a crash from the committed tool round", async () => {
    // Given: a process ran step 1's tool and died during step 2's request.
    const host = createInMemoryHost();
    const lookup = effectTool("LOOKUP_RESULT");
    const tools = { lookup: lookup.tool };
    const crashed = deferred<void>();
    await crashDuringTurn(host, tools, crashed.promise, [
      callTools(["call_lookup", "lookup"]),
      () => {
        crashed.resolve();
        return never();
      },
    ]);

    // When: a restarted process continues the thread.
    const recovered = await continueAfterRestart(host, tools);

    // Then: the model resumes after the round, which never runs again.
    expect(recovered.events).toContain("turn-end");
    expect(recovered.history.split("LOOKUP_RESULT")).toHaveLength(2);
    expect(lookup.effects.count).toBe(1);
  });

  it("restores every finished parallel result of a crashed step", async () => {
    // Given: one step called three tools; two finished, one never did.
    const host = createInMemoryHost();
    const deploy = effectTool("DEPLOYED");
    const notify = effectTool("NOTIFIED");
    const probe = hangingTool("pure", { output: "PROBED" });
    const tools = {
      deploy: deploy.tool,
      notify: notify.tool,
      probe: probe.tool,
    };
    await crashDuringTurn(
      host,
      tools,
      probe.called(),
      [
        callTools(
          ["call_deploy", "deploy"],
          ["call_notify", "notify"],
          ["call_probe", "probe"]
        ),
      ],
      2
    );

    // When: a restarted process continues the thread.
    const recovered = await continueAfterRestart(host, tools);

    // Then: both results reach the model once and neither tool reruns; only
    // the unfinished pure call runs again.
    expect(recovered.events).toContain("turn-end");
    expect(recovered.history.split("DEPLOYED")).toHaveLength(2);
    expect(recovered.history.split("NOTIFIED")).toHaveLength(2);
    expect(recovered.history.split("PROBED")).toHaveLength(2);
    expect(deploy.effects.count).toBe(1);
    expect(notify.effects.count).toBe(1);
    expect(probe.calls).toHaveLength(2);
  });

  it("keeps restored results across a second crash", async () => {
    // Given: a recovered attempt that journaled a new step of its own before
    // its process also died.
    const host = createInMemoryHost();
    const deploy = effectTool("DEPLOYED");
    const probe = hangingTool("pure");
    const recheck = hangingTool("idempotent");
    const tools = {
      deploy: deploy.tool,
      probe: probe.tool,
      recheck: recheck.tool,
    };
    await crashDuringTurn(
      host,
      tools,
      probe.called(),
      [callTools(["call_deploy", "deploy"], ["call_probe", "probe"])],
      1
    );
    const recovering = await createAgent({
      host: restartedHost(host),
      model: scriptedModel([callTools(["call_recheck", "recheck"])]).model,
      tools,
    });
    const recovered = await recovering.thread(THREAD).continue();
    collect(recovered ?? emptyTurn()).catch(() => undefined);
    await recheck.called();
    await expireLease(host);

    // When: a third process continues the thread.
    const restarted = await continueAfterRestart(host, tools);

    // Then: the restored result is still there, once.
    expect(restarted.events).toContain("turn-end");
    expect(restarted.history.split("DEPLOYED")).toHaveLength(2);
    expect(deploy.effects.count).toBe(1);
  });

  it("restores a failed tool call as its error result", async () => {
    // Given: one step's tool failed while its sibling never finished.
    const host = createInMemoryHost();
    const probe = hangingTool("pure");
    const tools = {
      flaky: checkpointedTool("idempotent", () => {
        throw new Error("FLAKY_FAILURE");
      }),
      probe: probe.tool,
    };
    await crashDuringTurn(
      host,
      tools,
      probe.called(),
      [callTools(["call_flaky", "flaky"], ["call_probe", "probe"])],
      1
    );

    // When: a restarted process continues the thread.
    const recovered = await continueAfterRestart(host, tools);

    // Then: the model sees the failure the original step produced.
    expect(recovered.events).toContain("turn-end");
    expect(recovered.history).toContain("FLAKY_FAILURE");
  });

  it("parks a run whose unfinished sibling forbids replay", async () => {
    // Given: one step's tool finished while a manual-recovery sibling
    // started and never finished.
    const host = createInMemoryHost();
    const deploy = effectTool("DEPLOYED");
    const transfer = hangingTool("manual-recovery");
    const tools = { deploy: deploy.tool, transfer: transfer.tool };
    await crashDuringTurn(
      host,
      tools,
      transfer.called(),
      [callTools(["call_transfer", "transfer"], ["call_deploy", "deploy"])],
      1
    );

    // When: a restarted process continues the thread.
    const second = scriptedModel([]);
    const restarted = await createAgent({
      host: restartedHost(host),
      model: second.model,
      tools,
    });
    const continued = restarted.thread(THREAD).continue();

    // Then: recovery fails closed before any model request.
    await expect(continued).rejects.toBeInstanceOf(
      ToolExecutionNeedsRecoveryError
    );
    await expect(continued).rejects.toThrow("transfer");
    expect(second.histories).toEqual([]);
    expect(await latestRun(host)).toMatchObject({ status: "needs-recovery" });
  });
});
