import type { ModelMessage } from "ai";
import type {
  AgentAfterStepContext,
  AgentBeforeStepContext,
  AgentLoopResult,
  AgentStepLifecycle,
} from "../agent-loop";
import type { ResolvedAgentPlugins } from "../plugins/runner";
import {
  type AgentPluginScope,
  runWithAgentPluginScope,
} from "../plugins/scope";
import type { AgentPluginEventName } from "../plugins/types";
import type { AgentInput, UserInput } from "./input";
import type { AgentRun } from "./run";
import type { RuntimeInputPlacement, RuntimeInputState } from "./runtime-input";

export interface AgentSessionLifecycle {
  readonly createScope: (signal: AbortSignal) => AgentPluginScope;
  readonly history: () => ModelMessage[];
  readonly plugins?: ResolvedAgentPlugins;
  readonly sessionKey: string;
  readonly steerCurrentRun: (
    runtimeInput: RuntimeInputState,
    input: AgentInput
  ) => Promise<AgentRun>;
  readonly steerSession: (input: AgentInput) => Promise<AgentRun>;
}

export function createRuntimeInputStepLifecycle({
  lifecycle,
  runtimeInput,
  stepLifecycle,
  withSteeringPlacement,
}: {
  readonly lifecycle: AgentSessionLifecycle;
  readonly runtimeInput: RuntimeInputState;
  readonly stepLifecycle?: AgentStepLifecycle;
  readonly withSteeringPlacement: <T>(
    placement: RuntimeInputPlacement,
    callback: () => Promise<T>
  ) => Promise<T>;
}): AgentStepLifecycle | undefined {
  const hasPluginStepHandlers =
    pluginHandlers(lifecycle, "afterStep").length > 0 ||
    pluginHandlers(lifecycle, "beforeStep").length > 0;
  if (!(stepLifecycle || hasPluginStepHandlers)) {
    return;
  }

  return {
    ...stepLifecycle,
    afterStep: (context) =>
      withSteeringPlacement("step-end", async () => {
        await stepLifecycle?.afterStep?.(context);
        await runPluginAfterStepHandlers(lifecycle, {
          context,
          runtimeInput,
        });
      }),
    beforeStep: (context) =>
      withSteeringPlacement("step-start", async () => {
        await stepLifecycle?.beforeStep?.(context);
        await runPluginBeforeStepHandlers(lifecycle, {
          context,
          runtimeInput,
        });
      }),
  };
}

export async function runPluginBeforeTurnHandlers(
  lifecycle: AgentSessionLifecycle,
  {
    input,
    runtimeInput,
    signal,
  }: {
    readonly input: UserInput;
    readonly runtimeInput: RuntimeInputState;
    readonly signal: AbortSignal;
  }
): Promise<boolean> {
  const handlers = pluginHandlers(lifecycle, "beforeTurn");
  if (handlers.length === 0) {
    return false;
  }

  const scope = lifecycle.createScope(signal);
  await runWithAgentPluginScope(scope, async () => {
    for (const handler of handlers) {
      await handler({
        history: lifecycle.history(),
        input,
        sessionKey: lifecycle.sessionKey,
        signal,
        steer: (nextInput) =>
          lifecycle.steerCurrentRun(runtimeInput, nextInput),
        type: "beforeTurn",
      });
    }
  });
  return true;
}

export async function runPluginBeforeStepHandlers(
  lifecycle: AgentSessionLifecycle,
  {
    context,
    runtimeInput,
  }: {
    readonly context: AgentBeforeStepContext;
    readonly runtimeInput: RuntimeInputState;
  }
): Promise<boolean> {
  const handlers = pluginHandlers(lifecycle, "beforeStep");
  if (handlers.length === 0) {
    return false;
  }

  const scope = lifecycle.createScope(context.signal);
  await runWithAgentPluginScope(scope, async () => {
    for (const handler of handlers) {
      await handler({
        history: context.history,
        sessionKey: lifecycle.sessionKey,
        signal: context.signal,
        steer: (input) => lifecycle.steerCurrentRun(runtimeInput, input),
        stepIndex: context.stepIndex,
        type: "beforeStep",
      });
    }
  });
  return true;
}

export async function runPluginAfterStepHandlers(
  lifecycle: AgentSessionLifecycle,
  {
    context,
    runtimeInput,
  }: {
    readonly context: AgentAfterStepContext;
    readonly runtimeInput: RuntimeInputState;
  }
): Promise<boolean> {
  const handlers = pluginHandlers(lifecycle, "afterStep");
  if (handlers.length === 0) {
    return false;
  }

  const scope = lifecycle.createScope(context.signal);
  await runWithAgentPluginScope(scope, () =>
    Promise.allSettled(
      handlers.map((handler) =>
        Promise.resolve().then(() =>
          handler({
            history: context.history,
            result: context.result,
            sessionKey: lifecycle.sessionKey,
            signal: context.signal,
            steer: (input) => lifecycle.steerCurrentRun(runtimeInput, input),
            stepIndex: context.stepIndex,
            type: "afterStep",
          })
        )
      )
    )
  );
  return true;
}

export async function runPluginAfterTurnHandlers(
  lifecycle: AgentSessionLifecycle,
  {
    input,
    result,
    signal,
  }: {
    readonly input: UserInput;
    readonly result: AgentLoopResult;
    readonly signal: AbortSignal;
  }
): Promise<boolean> {
  const handlers = pluginHandlers(lifecycle, "afterTurn");
  if (handlers.length === 0) {
    return false;
  }

  const scope = lifecycle.createScope(signal);
  await runWithAgentPluginScope(scope, () =>
    Promise.allSettled(
      handlers.map((handler) =>
        Promise.resolve().then(() =>
          handler({
            history: lifecycle.history(),
            input,
            result,
            sessionKey: lifecycle.sessionKey,
            signal,
            steer: lifecycle.steerSession,
            type: "afterTurn",
          })
        )
      )
    )
  );
  return true;
}

function pluginHandlers(
  lifecycle: AgentSessionLifecycle,
  eventName: AgentPluginEventName
) {
  return lifecycle.plugins?.eventHandlers.get(eventName) ?? [];
}
