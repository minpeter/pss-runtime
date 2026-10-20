import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../../agent/core/agent";
import type { RecoveryResolution } from "../../../agent/resume/resolve-recovery";
import { toolStepJournal } from "../../../execution/host/tool-step-journal";
import {
  assistantMessage,
  createCallbackModel,
  eventTypes,
} from "../../../testing/test-fixtures";
import { collect } from "../../../thread/handle/test-support";
import type { AgentTurn } from "../../../thread/protocol/turn";
import { INTERRUPTED_TOOL_CALL_TEXT } from "../../../thread/runtime/recovered-tool-round";
import { decodeStoredThreadSnapshot } from "../../../thread/state/snapshot";
import {
  ACT_CALL,
  ACT_OUTPUT,
  CRASH_CHILD_ENV,
  type CrashChildConfig,
  type CrashScenario,
  FIRST_CALL,
  FIRST_OUTPUT,
  KILL_POINT_LINE,
  MATRIX_THREAD,
  matrixTools,
  OPERATOR_OUTPUT,
  PARTIAL_ANSWER,
  type RecoveryKillPoint,
  readEffects,
} from "./crash-matrix.test-support";
import { createFileHost } from "./file-host";

/** What committed history tells the model a call returned. */
type Outcome = "absent" | "interrupted" | "operator" | "output";

/** What the store holds for `act` once the turn's process died. */
type AtKill =
  /** History holds only the user message; no tool checkpoint was written. */
  | "no-tool-checkpoint"
  /** History holds only the user message; the journal records `act` unfinished. */
  | "act-inflight"
  /** History holds only the user message; the journal holds `act`'s result. */
  | "act-result"
  /** History already holds the step's tool round. */
  | "round-committed";

interface MatrixRow extends CrashScenario {
  /** Attempts of `act` that applied its effect, in order. */
  readonly actAttempts: readonly number[];
  readonly actOutcome: Outcome;
  readonly atKill: AtKill;
  /** Whether the turn's process stays alive while another one continues. */
  readonly liveOwner?: boolean;
  /** Whether recovery waited for a decision before the turn went on. */
  readonly parked: boolean;
  /** The first recovery runs in a process that is SIGKILLed here too. */
  readonly recoveryKill?: RecoveryKillPoint;
  /** Decision recorded for a parked run; by default, `interrupt`. */
  readonly resolution?: RecoveryResolution;
}

// Each row kills a real process at one point of a turn whose step calls
// `act`, then continues the thread from another process.
const MATRIX: readonly MatrixRow[] = [
  // The streamed answer was never saved, so the model is asked again.
  {
    actAttempts: [],
    actOutcome: "absent",
    atKill: "no-tool-checkpoint",
    kill: "model-stream",
    name: "model mid-stream",
    parked: false,
    policy: "interrupt",
  },
  // A step of only pure calls is asked again; nothing reruns on its own.
  {
    actAttempts: [],
    actOutcome: "absent",
    atKill: "no-tool-checkpoint",
    kill: "tool-start",
    name: "pure call before its effect",
    parked: false,
    policy: "pure",
  },
  {
    actAttempts: [1],
    actOutcome: "absent",
    atKill: "no-tool-checkpoint",
    kill: "tool-effect",
    name: "pure call after its effect",
    parked: false,
    policy: "pure",
  },
  // A pure call journaled beside a finished sibling runs again.
  {
    actAttempts: [1, 2],
    actOutcome: "output",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "pure call beside a finished sibling",
    parked: false,
    policy: "pure",
    sibling: true,
  },
  // An idempotent call runs again under its key, as the next attempt.
  {
    actAttempts: [2],
    actOutcome: "output",
    atKill: "act-inflight",
    kill: "tool-start",
    name: "idempotent call before its effect",
    parked: false,
    policy: "idempotent",
  },
  {
    actAttempts: [1, 2],
    actOutcome: "output",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "idempotent call after its effect",
    parked: false,
    policy: "idempotent",
  },
  // Other calls never run again: the model hears they were interrupted.
  {
    actAttempts: [],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-start",
    name: "interrupt call before its effect",
    parked: false,
    policy: "interrupt",
  },
  {
    actAttempts: [1],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "interrupt call after its effect",
    parked: false,
    policy: "interrupt",
  },
  {
    actAttempts: [],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-start",
    name: "manual-recovery call before its effect",
    parked: true,
    policy: "manual-recovery",
  },
  {
    actAttempts: [1],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "manual-recovery call after its effect",
    parked: true,
    policy: "manual-recovery",
  },
  // A tool that declares no policy is treated as manual-recovery.
  {
    actAttempts: [1],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "call without a declared policy after its effect",
    parked: true,
    policy: "default",
  },
  // A recorded decision overrides the policy.
  {
    actAttempts: [1, 2],
    actOutcome: "output",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "manual-recovery call the operator reruns",
    parked: true,
    policy: "manual-recovery",
    resolution: { otherwise: { action: "rerun" } },
  },
  {
    actAttempts: [1],
    actOutcome: "operator",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "manual-recovery call the operator answers",
    parked: true,
    policy: "manual-recovery",
    resolution: {
      toolCalls: { [ACT_CALL]: { action: "result", output: OPERATOR_OUTPUT } },
    },
  },
  // A saved result is kept, whether or not its step committed.
  {
    actAttempts: [1],
    actOutcome: "output",
    atKill: "act-result",
    kill: "after-result",
    name: "result saved, step not committed",
    parked: false,
    policy: "interrupt",
  },
  {
    actAttempts: [1],
    actOutcome: "output",
    atKill: "round-committed",
    kill: "after-commit",
    name: "tool round committed",
    parked: false,
    policy: "interrupt",
  },
  {
    actAttempts: [1],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "finished sibling, interrupted call",
    parked: false,
    policy: "interrupt",
    sibling: true,
  },
  // A run whose process is alive stays with it until that process dies.
  {
    actAttempts: [1],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-effect",
    liveOwner: true,
    name: "interrupt call whose process is still alive",
    parked: false,
    policy: "interrupt",
  },
  // A recovery killed in turn is recovered again, without repeating outcomes.
  {
    actAttempts: [1],
    actOutcome: "interrupted",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "interrupt call, recovery killed at its model request",
    parked: false,
    policy: "interrupt",
    recoveryKill: "model-request",
  },
  {
    actAttempts: [1, 2, 3],
    actOutcome: "output",
    atKill: "act-inflight",
    kill: "tool-effect",
    name: "idempotent call, recovery killed after its rerun's effect",
    parked: false,
    policy: "idempotent",
    recoveryKill: "tool-effect",
  },
];

const TSX_LOADER = import.meta.resolve("tsx");
const CHILD_ENTRY = `import { runCrashChild } from ${JSON.stringify(
  new URL("./crash-matrix.test-support.ts", import.meta.url).href
)};
await runCrashChild();`;

// Rows run one at a time: each starts a child process that loads the
// runtime source, and a burst of them would starve other test files.
describe("SIGKILL crash matrix on a file host", () => {
  it.for(MATRIX)(
    "recovers a turn killed at: $name",
    { timeout: 60_000 },
    async (
      {
        actAttempts,
        actOutcome,
        atKill,
        liveOwner,
        parked,
        recoveryKill,
        resolution,
        ...scenario
      },
      { signal }
    ) => {
      const root = await mkdtemp(join(tmpdir(), "pss-crash-matrix-"));
      const config: CrashChildConfig = {
        directory: join(root, "threads"),
        effectsFile: join(root, "effects.jsonl"),
        scenario,
      };
      try {
        // Given: the process running the turn is SIGKILLed at the point.
        const crashedPid = await killAtKillPoint(
          config,
          signal,
          liveOwner
            ? async (pid) => {
                // Then: while it lives, another process cannot take its run.
                await expect(continueThread(config)).rejects.toMatchObject({
                  code: "THREAD_CONTINUATION_BUSY",
                });
                expect(await listRuns(config.directory)).toMatchObject([
                  { lease: { owner: { pid } }, status: "running" },
                ]);
              }
            : undefined
        );

        // Then: the store holds what the turn saved before the kill.
        const saved = await savedState(config.directory);
        expect(saved).toMatchObject(
          expectedAtKill(atKill, scenario.sibling ?? false)
        );

        // Given: a first recovery is SIGKILLed at its own point too.
        const pids = [crashedPid];
        if (recoveryKill) {
          pids.push(await killAtKillPoint({ ...config, recoveryKill }, signal));
        }

        // When: another process continues the thread.
        const recovered = await continueThread(config, resolution);

        // Then: the same run finishes, and only the scenario's calls ran.
        expect(recovered.parked).toBe(parked);
        expect(recovered.events).toContain("turn-end");
        expect(recovered.events).not.toContain("turn-error");
        expect(recovered.runs.map((run) => run.status)).toEqual(["completed"]);
        const runId = recovered.runs[0]?.runId;
        const effects = readEffects(config.effectsFile);
        const acts = effects.filter((effect) => effect.tool === "act");
        expect(acts.map((effect) => effect.attempt)).toEqual(actAttempts);
        for (const effect of effects) {
          // Each killed process ran one attempt; this one ran the rest,
          // under the call's own idempotency key.
          expect(effect.pid).toBe(
            pids[(effect.attempt ?? 0) - 1] ?? process.pid
          );
          expect(effect.idempotencyKey).toBe(
            `${runId}:${effect.tool === "act" ? ACT_CALL : FIRST_CALL}`
          );
        }
        expect(
          effects.filter((effect) => effect.tool === "first")
        ).toHaveLength(scenario.sibling ? 1 : 0);

        // Then: the model was asked once, and saw the call's outcome.
        expect(recovered.modelPrompts).toHaveLength(1);
        const prompt = recovered.modelPrompts[0] ?? [];
        expect(outcome(prompt, ACT_CALL)).toBe(actOutcome);
        expect(historyShape(prompt).calls.includes(ACT_CALL)).toBe(
          actOutcome !== "absent"
        );

        // Then: committed history pairs every call with one result.
        const history = recovered.history;
        expect(outcome(history, ACT_CALL)).toBe(actOutcome);
        if (scenario.sibling) {
          expect(outcome(history, FIRST_CALL)).toBe("output");
        }
        const shape = historyShape(history);
        expect(shape.users).toBe(1);
        expect([...shape.results].sort()).toEqual([...shape.calls].sort());
        expect(new Set(shape.calls).size).toBe(shape.calls.length);
        expect(shape.final).toContain("DONE");
        expect(JSON.stringify(history)).not.toContain(PARTIAL_ANSWER);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );
});

/**
 * Runs `config` in a child process until its kill point, runs `whileAlive`
 * there, then SIGKILLs the child. Returns the child's pid.
 */
async function killAtKillPoint(
  config: CrashChildConfig,
  signal: AbortSignal,
  whileAlive?: (pid: number) => Promise<void>
): Promise<number> {
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--input-type=module", "--eval", CHILD_ENTRY],
    {
      env: { ...process.env, [CRASH_CHILD_ENV]: JSON.stringify(config) },
      // A timed-out row must not leave its child running.
      killSignal: "SIGKILL",
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const exited = once(child, "exit") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes(KILL_POINT_LINE)) {
          resolve();
        }
      });
      exited.then(([code, signal]) => {
        reject(
          new Error(
            `The crash child exited (${signal ?? code}) before its kill point:\n${stderr}`
          )
        );
      }, reject);
    });
    if (child.pid !== undefined) {
      await whileAlive?.(child.pid);
    }
  } finally {
    child.kill("SIGKILL");
  }
  const [, exitSignal] = await exited;
  if (exitSignal !== "SIGKILL" || child.pid === undefined) {
    throw new Error(
      `Expected the crash child to die by SIGKILL, got ${exitSignal}.`
    );
  }
  return child.pid;
}

async function listRuns(directory: string) {
  const { store } = createFileHost({ directory });
  return (await store.turns.listByThreadKey?.(MATRIX_THREAD)) ?? [];
}

/** Committed history and `act`'s state in the run's latest checkpoint. */
async function savedState(directory: string) {
  const { store } = createFileHost({ directory });
  const [run] = await listRuns(directory);
  if (!run) {
    throw new Error("Expected the killed turn's run to be saved.");
  }
  const history = decodeStoredThreadSnapshot(
    await store.threads.load(MATRIX_THREAD)
  );
  const journal = toolStepJournal(await store.checkpoints.latest(run.runId));
  const callState = (toolCallId: string) => {
    if (journal?.results.some((result) => result.toolCallId === toolCallId)) {
      return "result";
    }
    if (journal?.inflight.some((intent) => intent.toolCallId === toolCallId)) {
      return "inflight";
    }
    return "absent";
  };
  return {
    act: callState(ACT_CALL),
    actCommitted: outcome(history, ACT_CALL),
    first: callState(FIRST_CALL),
    journal: journal !== undefined,
    roles: history.map((message) => message.role),
  };
}

function expectedAtKill(atKill: AtKill, sibling: boolean) {
  const userOnly = { actCommitted: "absent", roles: ["user"] };
  const journaled = {
    ...userOnly,
    first: sibling ? "result" : "absent",
    journal: true,
  };
  switch (atKill) {
    case "no-tool-checkpoint":
      return { ...userOnly, journal: false };
    case "act-inflight":
      return { ...journaled, act: "inflight" };
    case "act-result":
      return { ...journaled, act: "result" };
    case "round-committed":
      return {
        actCommitted: "output",
        roles: ["user", "assistant", "tool"],
      };
    default:
      throw new Error(`Unknown kill state: ${atKill satisfies never}`);
  }
}

/**
 * Continues the thread on a new host, as a restarted `pss` would. A run
 * waiting for a decision gets `resolution`, by default reporting every
 * unfinished call as interrupted. Records every prompt the model receives.
 */
async function continueThread(
  { directory, effectsFile, scenario }: CrashChildConfig,
  resolution: RecoveryResolution = { otherwise: { action: "interrupt" } }
) {
  const host = createFileHost({ directory });
  const modelPrompts: (readonly ModelMessage[])[] = [];
  const agent = await createAgent({
    host,
    model: createCallbackModel(({ history }) => {
      modelPrompts.push(history);
      return Promise.resolve([assistantMessage("DONE")]);
    }),
    tools: matrixTools(scenario, effectsFile),
  });
  try {
    let parked = false;
    const turn: AgentTurn | null | undefined = await agent
      .thread(MATRIX_THREAD)
      .continue()
      .catch(async (error: unknown) => {
        const [run] = await listRuns(directory);
        if (run?.status !== "needs-recovery") {
          throw error;
        }
        parked = true;
        await agent.resolveRecovery(run.runId, resolution);
        return await agent.resume(run.runId);
      });
    if (!turn) {
      throw new Error("Expected the killed turn to continue.");
    }
    const events = eventTypes(await collect(turn));
    return {
      events,
      history: decodeStoredThreadSnapshot(
        await host.store.threads.load(MATRIX_THREAD)
      ),
      modelPrompts,
      parked,
      runs: await listRuns(directory),
    };
  } finally {
    await agent.dispose();
  }
}

function outcome(
  history: readonly ModelMessage[],
  toolCallId: string
): Outcome | string {
  const results = history.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter(
          (part) =>
            part.type === "tool-result" && part.toolCallId === toolCallId
        )
      : []
  );
  const text = JSON.stringify(results);
  if (results.length === 0) {
    return "absent";
  }
  if (results.length !== 1) {
    return text;
  }
  if (text.includes(INTERRUPTED_TOOL_CALL_TEXT)) {
    return "interrupted";
  }
  if (text.includes(OPERATOR_OUTPUT)) {
    return "operator";
  }
  if (text.includes(ACT_OUTPUT) || text.includes(FIRST_OUTPUT)) {
    return "output";
  }
  return text;
}

function historyShape(history: readonly ModelMessage[]) {
  const calls = history.flatMap((message) =>
    message.role === "assistant" && typeof message.content !== "string"
      ? message.content.flatMap((part) =>
          part.type === "tool-call" ? [part.toolCallId] : []
        )
      : []
  );
  const results = history.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [part.toolCallId] : []
        )
      : []
  );
  return {
    calls,
    final: JSON.stringify(history.at(-1) ?? null),
    results,
    users: history.filter((message) => message.role === "user").length,
  };
}
