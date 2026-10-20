import type { ModelMessage } from "ai";
import { createAgent } from "../../agent/core/agent";
import type { AgentHost } from "../../execution/host/types";
import type { ModelStepOutput } from "../../llm/model-step-types";
import type { RuntimeToolRetryPolicy } from "../../llm/tool-execution-types";
import { checkpointedTool } from "../../testing/execution-checkpoint-test-support";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
  toolCallPart,
} from "../../testing/test-fixtures";
import { decodeStoredThreadSnapshot } from "../state/snapshot";
import { collect } from "./test-support";

export const THREAD = "step-journal";

export type Tools = NonNullable<Parameters<typeof createAgent>[0]["tools"]>;

/** A model that answers each request with the next scripted step. */
export function scriptedModel(
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

export const callTools =
  (...calls: readonly [string, string][]) =>
  () =>
    Promise.resolve([
      assistantMessage(calls.map(([id, name]) => toolCallPart(id, name))),
    ]);

export const never = () => new Promise<ModelStepOutput>(() => undefined);

/** A tool that counts its effects and returns a fixed output. */
export function effectTool(
  output: string,
  policy: RuntimeToolRetryPolicy = "idempotent"
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

/** Options the runtime passed to one call of a tool. */
interface RecordedToolCall {
  readonly attempt?: number;
  readonly idempotencyKey?: string;
  readonly toolCallId?: string;
}

/**
 * A tool whose first `hangs` calls never finish, as when their process
 * dies; later calls return `output`.
 */
export function hangingTool(
  policy: RuntimeToolRetryPolicy,
  { hangs = 1, output = "RERUN_OUTPUT" } = {}
) {
  const calls: RecordedToolCall[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    calls,
    /** Settles once the tool has been called `count` times. */
    called: (count = 1) =>
      new Promise<void>((resolve) => {
        if (calls.length >= count) {
          resolve();
        } else {
          waiters.push({ count, resolve });
        }
      }),
    tool: checkpointedTool(policy, (_input, options) => {
      const { attempt, idempotencyKey, toolCallId } =
        options as RecordedToolCall;
      calls.push({ attempt, idempotencyKey, toolCallId });
      for (const waiter of waiters.filter((w) => calls.length >= w.count)) {
        waiter.resolve();
      }
      return calls.length <= hangs ? new Promise(() => undefined) : output;
    }),
  };
}

/**
 * Another process on the same store: distinct drain and live-input owners.
 * Once `dies()` holds, its store transactions never settle, as when the
 * process dies before they commit.
 */
export function restartedHost<Host extends AgentHost>(
  host: Host,
  dies: () => boolean = () => false
): Host {
  return {
    ...host,
    store: new Proxy(host.store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "transaction") {
          return (...args: Parameters<AgentHost["store"]["transaction"]>) =>
            dies() ? new Promise(() => undefined) : value.apply(target, args);
        }
        return value.bind(target);
      },
    }),
  };
}

export async function committedHistory(host: AgentHost): Promise<string> {
  return JSON.stringify(
    decodeStoredThreadSnapshot(await host.store.threads.load(THREAD))
  );
}

/**
 * Runs a turn in a process that dies once `crashed` settles, after the
 * run's latest checkpoint journals `results` finished results.
 */
export async function crashDuringTurn(
  host: AgentHost,
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
export async function continueAfterRestart(
  host: AgentHost,
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
  return await drainContinuation(agent, model.histories);
}

/** Drains the thread's continued turn; returns its events and first prompt. */
export async function drainContinuation(
  agent: Awaited<ReturnType<typeof createAgent>>,
  histories: readonly string[]
): Promise<{ readonly events: string[]; readonly history: string }> {
  const turn = await agent.thread(THREAD).continue();
  if (!turn) {
    throw new Error("Expected the crashed run to continue.");
  }
  const events = eventTypes(await collect(turn));
  return { events, history: histories[0] ?? "" };
}

/** The thread's latest run. */
export async function latestRun(host: AgentHost) {
  const runs = (await host.store.turns.listByThreadKey?.(THREAD)) ?? [];
  const run = runs.at(-1);
  if (!run) {
    throw new Error("Expected a recorded run.");
  }
  return run;
}

/** Waits until the run's latest checkpoint journals `count` results. */
async function waitForResults(host: AgentHost, count: number): Promise<void> {
  await waitForJournal(host, (results) => results.length >= count);
}

/** Waits until the run's latest checkpoint journals the call's result. */
export async function waitForResult(
  host: AgentHost,
  toolCallId: string
): Promise<void> {
  await waitForJournal(host, (results) =>
    results.some((result) => result.toolCallId === toolCallId)
  );
}

async function waitForJournal(
  host: AgentHost,
  done: (results: readonly { readonly toolCallId?: string }[]) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [run] = (await host.store.turns.listByThreadKey?.(THREAD)) ?? [];
    const latest = run ? await host.store.checkpoints.latest(run.runId) : null;
    const results = (
      latest?.runtimeState as { results?: { toolCallId?: string }[] } | null
    )?.results;
    if (done(results ?? [])) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected the journaled tool results.");
}

/** Lets the run's current lease lapse, as if its holder died long ago. */
export async function expireLease(host: AgentHost): Promise<void> {
  const run = await latestRun(host);
  if (!run.lease) {
    throw new Error("Expected a leased run.");
  }
  await host.store.turns.update({
    ...run,
    lease: { ...run.lease, leaseUntilMs: 0 },
  });
}

export function emptyTurn(): Parameters<typeof collect>[0] {
  throw new Error("Expected the crashed run to continue.");
}
