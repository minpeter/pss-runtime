import { appendFileSync, readFileSync } from "node:fs";
import type { Tool } from "ai";
import { createAgent } from "../../../agent/core/agent";
import type { Checkpoint } from "../../../execution/host/checkpoint-types";
import { toolStepJournal } from "../../../execution/host/tool-step-journal";
import type { AgentHost } from "../../../execution/host/types";
import { deferred } from "../../../internal/deferred";
import type { RuntimeToolRetryPolicy } from "../../../llm/tool-execution-types";
import { checkpointedTool } from "../../../testing/execution-checkpoint-test-support";
import {
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4StreamResult,
} from "../../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
  toolCallPart,
} from "../../../testing/test-fixtures";
import { createFileHost } from "./file-host";

/** Where in a turn the crashing process is killed. */
export type KillPoint =
  /** While the model streams its first answer. */
  | "model-stream"
  /** In the tool, before its effect. */
  | "tool-start"
  /** In the tool, after its effect, before its result is saved. */
  | "tool-effect"
  /** After the tool's result is checkpointed, before the step commits. */
  | "after-result"
  /** After the step committed its tool round, during the next request. */
  | "after-commit";

/** Where in a recovery the recovering process is killed. */
export type RecoveryKillPoint =
  /** At the recovery's first model request. */
  | "model-request"
  /** In a rerun of the tool, after its effect, before its result is saved. */
  | "tool-effect";

/** A retry policy, or `default` for a tool that declares none. */
export type ActPolicy = RuntimeToolRetryPolicy | "default";

export interface CrashScenario {
  readonly kill: KillPoint;
  readonly name: string;
  /** Retry policy of `act`, the call the kill point targets. */
  readonly policy: ActPolicy;
  /** Whether the step also calls `first`, which finishes before the crash. */
  readonly sibling?: boolean;
}

export interface CrashChildConfig {
  readonly directory: string;
  readonly effectsFile: string;
  /**
   * Set when the child continues the crashed thread instead of starting the
   * turn; it is killed at this point of the recovery.
   */
  readonly recoveryKill?: RecoveryKillPoint;
  readonly scenario: CrashScenario;
}

/** One run of a tool's effect, as the tool recorded it. */
export interface ToolEffect {
  readonly attempt?: number;
  readonly idempotencyKey?: string;
  readonly pid: number;
  readonly tool: "act" | "first";
}

export const MATRIX_THREAD = "crash-matrix";
export const ACT_CALL = "call-act";
export const FIRST_CALL = "call-first";
export const ACT_OUTPUT = "ACT_OUTPUT";
export const FIRST_OUTPUT = "FIRST_OUTPUT";
/** Output an operator records for `act` through `agent.resolveRecovery()`. */
export const OPERATOR_OUTPUT = "OPERATOR_OUTPUT";
export const PARTIAL_ANSWER = "PARTIAL_ANSWER";
/** Carries the child's {@link CrashChildConfig} as JSON. */
export const CRASH_CHILD_ENV = "PSS_CRASH_MATRIX_CHILD";
/** The line a child prints once it reached its kill point. */
export const KILL_POINT_LINE = "PSS_CRASH_MATRIX_KILL_POINT";
/** How long a child that was never killed runs: past any row's timeout. */
const CHILD_LIFETIME_MS = 90_000;

/**
 * The step's tools. Each records its effect to `effectsFile` before it
 * returns; `act` runs `hooks` around its effect.
 */
export function matrixTools(
  scenario: CrashScenario,
  effectsFile: string,
  hooks: {
    readonly afterEffect?: () => Promise<void>;
    readonly beforeEffect?: () => Promise<void>;
  } = {}
): Record<string, Tool> {
  const act = actTool(scenario.policy, async (_input, options) => {
    await hooks.beforeEffect?.();
    recordEffect(effectsFile, "act", options);
    await hooks.afterEffect?.();
    return ACT_OUTPUT;
  });
  if (!scenario.sibling) {
    return { act };
  }
  const first = checkpointedTool("idempotent", (_input, options) => {
    recordEffect(effectsFile, "first", options);
    return FIRST_OUTPUT;
  });
  return { act, first };
}

function actTool(
  policy: ActPolicy,
  execute: Parameters<typeof checkpointedTool>[1]
): Tool {
  if (policy !== "default") {
    return checkpointedTool(policy, execute);
  }
  const { retryPolicy: _declared, ...undeclared } = checkpointedTool(
    "manual-recovery",
    execute
  );
  return undeclared;
}

export function readEffects(effectsFile: string): ToolEffect[] {
  let text: string;
  try {
    text = readFileSync(effectsFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ToolEffect);
}

/**
 * Runs the scenario's turn on a file host in this process until its kill
 * point, then waits there for the parent's SIGKILL.
 */
export async function runCrashChild(): Promise<void> {
  const config = JSON.parse(
    process.env[CRASH_CHILD_ENV] ?? ""
  ) as CrashChildConfig;
  // The parent's SIGKILL ends this process; if the parent died first, it
  // ends itself instead of running on.
  setTimeout(() => process.exit(2), CHILD_LIFETIME_MS);
  if (config.recoveryKill) {
    return await runRecoveryChild(config, config.recoveryKill);
  }
  const { directory, effectsFile, scenario } = config;
  const firstJournaled = deferred<void>();
  const host = afterCheckpoint(createFileHost({ directory }), (checkpoint) => {
    if (checkpoint.phase !== "after-tool") {
      return;
    }
    if (journalsResult(checkpoint, FIRST_CALL)) {
      firstJournaled.resolve();
    }
    if (
      scenario.kill === "after-result" &&
      journalsResult(checkpoint, ACT_CALL)
    ) {
      return killPoint();
    }
  });
  const agent = await createAgent({
    host,
    model: crashingModel(scenario),
    tools: matrixTools(scenario, effectsFile, {
      // The sibling's result is journaled before `act` dies.
      beforeEffect: async () => {
        if (scenario.sibling) {
          await firstJournaled.promise;
        }
        if (scenario.kill === "tool-start") {
          await killPoint();
        }
      },
      afterEffect: async () => {
        if (scenario.kill === "tool-effect") {
          await killPoint();
        }
      },
    }),
  });
  const turn = await agent.thread(MATRIX_THREAD).send("go");
  for await (const event of turn.events()) {
    if (
      scenario.kill === "model-stream" &&
      event.type === "assistant-output-delta"
    ) {
      await killPoint();
    }
  }
  throw new Error(`${scenario.name}: the turn ended before its kill point.`);
}

/**
 * Continues the crashed thread on a file host in this process until the
 * recovery's kill point, then waits there for the parent's SIGKILL.
 */
async function runRecoveryChild(
  { directory, effectsFile, scenario }: CrashChildConfig,
  kill: RecoveryKillPoint
): Promise<void> {
  const agent = await createAgent({
    host: createFileHost({ directory }),
    model: createCallbackModel(() =>
      kill === "model-request"
        ? killPoint()
        : Promise.reject(new Error(`${scenario.name}: missed its kill point.`))
    ),
    tools: matrixTools(scenario, effectsFile, {
      afterEffect: async () => {
        if (kill === "tool-effect") {
          await killPoint();
        }
      },
    }),
  });
  const turn = await agent.thread(MATRIX_THREAD).continue();
  if (!turn) {
    throw new Error(`${scenario.name}: there was no turn to recover.`);
  }
  for await (const _event of turn.events()) {
    // The recovery runs until its kill point.
  }
  throw new Error(
    `${scenario.name}: the recovery ended before its kill point.`
  );
}

function killPoint(): Promise<never> {
  process.stdout.write(`${KILL_POINT_LINE}\n`);
  return new Promise<never>(() => undefined);
}

/** Step 1 calls the tools; step 2 starts only after step 1 committed. */
function crashingModel(scenario: CrashScenario) {
  if (scenario.kill === "model-stream") {
    return createStreamingMockLanguageModelV4(() =>
      Promise.resolve({ stream: endlessAnswer() })
    );
  }
  let step = 0;
  return createCallbackModel(() => {
    step += 1;
    if (step === 1) {
      const calls = [toolCallPart(ACT_CALL, "act")];
      return Promise.resolve([
        assistantMessage(
          scenario.sibling
            ? [toolCallPart(FIRST_CALL, "first"), ...calls]
            : calls
        ),
      ]);
    }
    if (scenario.kill === "after-commit") {
      return killPoint();
    }
    return Promise.reject(
      new Error(`${scenario.name}: missed its kill point.`)
    );
  });
}

/** An answer whose stream starts and never ends. */
function endlessAnswer(): MockLanguageModelV4StreamResult["stream"] {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ id: "text-1", type: "text-start" });
      controller.enqueue({
        delta: PARTIAL_ANSWER,
        id: "text-1",
        type: "text-delta",
      });
    },
  });
}

/**
 * `host` whose fenced checkpoint writes call `observe` once written; the
 * write's caller waits for `observe` to settle.
 */
function afterCheckpoint(
  host: AgentHost,
  observe: (checkpoint: Checkpoint) => Promise<void> | undefined
): AgentHost {
  const fenced = host.store.leaseFencedCheckpoints;
  if (!fenced) {
    throw new Error("Expected a store with fenced checkpoints.");
  }
  const observed = {
    appendFenced: async (
      ...args: Parameters<typeof fenced.appendFenced>
    ): ReturnType<typeof fenced.appendFenced> => {
      const result = await fenced.appendFenced(...args);
      if (result.ok) {
        await observe(args[0]);
      }
      return result;
    },
  };
  return {
    ...host,
    store: new Proxy(host.store, {
      get(target, property) {
        if (property === "leaseFencedCheckpoints") {
          return observed;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

/** Whether `checkpoint`'s journal holds `toolCallId`'s finished result. */
function journalsResult(checkpoint: Checkpoint, toolCallId: string): boolean {
  return (
    toolStepJournal(checkpoint)?.results.some(
      (result) => result.toolCallId === toolCallId
    ) ?? false
  );
}

function recordEffect(
  effectsFile: string,
  tool: ToolEffect["tool"],
  options: unknown
): void {
  const { attempt, idempotencyKey } = options as Pick<
    ToolEffect,
    "attempt" | "idempotencyKey"
  >;
  const effect: ToolEffect = {
    attempt,
    idempotencyKey,
    pid: process.pid,
    tool,
  };
  appendFileSync(effectsFile, `${JSON.stringify(effect)}\n`);
}
