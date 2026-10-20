import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agent/core/agent";
import { deferred } from "../../internal/deferred";
import type { ModelStepOutput } from "../../llm/model-step-types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import { createInMemoryHost } from "../../platform/memory";
import type { InMemoryHost } from "../../platform/memory/execution/execution-host";
import { checkpointedTool } from "../../testing/execution-checkpoint-test-support";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  toolCallPart,
} from "../../testing/test-fixtures";
import { decodeStoredThreadSnapshot } from "../state/snapshot";
import { collect } from "./test-support";

const THREAD = "step-journal";

/** A model that answers each request with the next scripted step. */
function scriptedModel(
  steps: readonly ((
    history: readonly ModelMessage[]
  ) => Promise<ModelStepOutput>)[]
): {
  readonly histories: string[];
  readonly model: ReturnType<typeof createCallbackModel>;
} {
  const histories: string[] = [];
  let index = 0;
  return {
    histories,
    model: createCallbackModel(({ history }) => {
      histories.push(JSON.stringify(history));
      const step = steps[index];
      index += 1;
      return step ? step(history) : Promise.resolve([assistantMessage("DONE")]);
    }),
  };
}

const callTools =
  (...calls: readonly [string, string][]) =>
  () =>
    Promise.resolve([
      assistantMessage(calls.map(([id, name]) => toolCallPart(id, name))),
    ]);

const never = () => new Promise<ModelStepOutput>(() => undefined);

/** A tool that counts its effects and returns a fixed output. */
function effectTool(
  output: string,
  policy: "idempotent" | "manual-recovery" | "pure" = "idempotent"
) {
  const effects = { count: 0 };
  return {
    effects,
    tool: checkpointedTool(policy, () => {
      effects.count += 1;
      return output;
    }),
  };
}

/** A tool whose call starts and never finishes, as when its process dies. */
function hangingTool(policy: "idempotent" | "manual-recovery" | "pure") {
  const started = deferred<void>();
  return {
    started: started.promise,
    tool: checkpointedTool(policy, () => {
      started.resolve();
      return new Promise(() => undefined);
    }),
  };
}

/** Another process on the same store: distinct drain and live-input owners. */
function restartedHost(host: InMemoryHost): InMemoryHost {
  return {
    ...host,
    store: new Proxy(host.store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

async function committedHistory(host: InMemoryHost): Promise<string> {
  return JSON.stringify(
    decodeStoredThreadSnapshot(await host.store.threads.load(THREAD))
  );
}

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
    const probe = hangingTool("pure");
    const tools = {
      deploy: deploy.tool,
      notify: notify.tool,
      probe: probe.tool,
    };
    await crashDuringTurn(
      host,
      tools,
      probe.started,
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

    // Then: both results reach the model once, and neither tool reruns.
    expect(recovered.events).toContain("turn-end");
    expect(recovered.history.split("DEPLOYED")).toHaveLength(2);
    expect(recovered.history.split("NOTIFIED")).toHaveLength(2);
    expect(recovered.history).not.toContain("call_probe");
    expect(deploy.effects.count).toBe(1);
    expect(notify.effects.count).toBe(1);
  });

  it("keeps restored results across a second crash", async () => {
    // Given: a recovered attempt that journaled a new step of its own before
    // its process also died.
    const host = createInMemoryHost();
    const deploy = effectTool("DEPLOYED");
    const probe = hangingTool("pure");
    const recheck = hangingTool("pure");
    const tools = {
      deploy: deploy.tool,
      probe: probe.tool,
      recheck: recheck.tool,
    };
    await crashDuringTurn(
      host,
      tools,
      probe.started,
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
    await recheck.started;
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
      probe.started,
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
      transfer.started,
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
    const [run] = (await host.store.turns.listByThreadKey?.(THREAD)) ?? [];
    expect(run).toMatchObject({ status: "needs-recovery" });
  });
});

type Tools = NonNullable<Parameters<typeof createAgent>[0]["tools"]>;

/**
 * Runs a turn in a process that dies once `crashed` settles, after the
 * run's latest checkpoint journals `results` finished results.
 */
async function crashDuringTurn(
  host: InMemoryHost,
  tools: Tools,
  crashed: Promise<void>,
  steps: Parameters<typeof scriptedModel>[0],
  results = 0
): Promise<void> {
  const agent = await createAgent({
    host,
    model: scriptedModel(steps).model,
    tools,
  });
  collect(await agent.thread(THREAD).send("go")).catch(() => undefined);
  await crashed;
  await waitForResults(host, results);
}

/** Continues the thread in a restarted process that answers "DONE". */
async function continueAfterRestart(
  host: InMemoryHost,
  tools: Tools
): Promise<{ readonly events: string[]; readonly history: string }> {
  const model = scriptedModel([
    () => Promise.resolve([assistantMessage("DONE")]),
  ]);
  const agent = await createAgent({
    host: restartedHost(host),
    model: model.model,
    tools,
  });
  const turn = await agent.thread(THREAD).continue();
  if (!turn) {
    throw new Error("Expected the crashed run to continue.");
  }
  const events = eventTypes(await collect(turn));
  return { events, history: model.histories[0] ?? "" };
}

/** Waits until the run's latest checkpoint journals `count` results. */
async function waitForResults(
  host: InMemoryHost,
  count: number
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [run] = (await host.store.turns.listByThreadKey?.(THREAD)) ?? [];
    const latest = run ? await host.store.checkpoints.latest(run.runId) : null;
    const results = (latest?.runtimeState as { results?: unknown[] } | null)
      ?.results;
    if ((results?.length ?? 0) >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${count} journaled tool results.`);
}

/** Lets the run's current lease lapse, as if its holder died long ago. */
async function expireLease(host: InMemoryHost): Promise<void> {
  const [run] = (await host.store.turns.listByThreadKey?.(THREAD)) ?? [];
  if (!run?.lease) {
    throw new Error("Expected a leased run.");
  }
  await host.store.turns.update({
    ...run,
    lease: { ...run.lease, leaseUntilMs: 0 },
  });
}

function emptyTurn(): Parameters<typeof collect>[0] {
  throw new Error("Expected the crashed run to continue.");
}
