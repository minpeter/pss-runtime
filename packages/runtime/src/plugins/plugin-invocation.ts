import type {
  PluginEventContext,
  PluginEventMap,
  PluginRequestResultMap,
} from "./api";
import { PluginHookError } from "./plugin-errors";
import { cloneEvent } from "./plugin-helpers";
import { reportPluginFailure } from "./plugin-report";
import { activeHandlers } from "./plugin-state";
import { isTerminalNotification, withTimeout } from "./plugin-timeout";
import type {
  PluginInvocationContext,
  PluginRegistration,
  PluginRuntimeState,
  RegisteredHandler,
} from "./plugin-types";

export async function notifyHandlers<E extends keyof PluginEventMap>(
  state: PluginRuntimeState,
  eventName: E,
  event: PluginEventMap[E],
  context: PluginInvocationContext
): Promise<void> {
  for (const { registered, registration } of activeHandlers(state, eventName)) {
    await invokeHandler(
      state,
      registration,
      eventName,
      registered,
      cloneEvent(event),
      context
    );
  }
}

export async function invokeHandler(
  state: PluginRuntimeState,
  registration: PluginRegistration,
  eventName: keyof PluginEventMap,
  registered: RegisteredHandler,
  event: PluginEventMap[keyof PluginEventMap],
  context: PluginInvocationContext
): Promise<unknown> {
  try {
    return await withTimeout(
      Promise.resolve(
        registered.handler(event, {
          history: structuredClone([...context.history]),
          signal: context.signal,
          thread: { key: context.threadKey },
        } as PluginEventContext)
      ),
      state.hookTimeoutMs,
      context.signal,
      { abortOnSignal: !isTerminalNotification(eventName) }
    );
  } catch (cause) {
    await throwHookFailure(state, registration, eventName, cause);
  }
}

export async function validateRequestResult(
  state: PluginRuntimeState,
  registration: PluginRegistration,
  event: keyof PluginRequestResultMap,
  result: unknown,
  actions: readonly string[]
): Promise<void> {
  if (result === undefined) {
    return;
  }
  if (
    result &&
    typeof result === "object" &&
    "action" in result &&
    typeof result.action === "string" &&
    actions.includes(result.action)
  ) {
    if (result.action === "transform") {
      if (event === "tool.call.before") {
        if (
          !("input" in result) ||
          (result as { readonly input?: unknown }).input === undefined
        ) {
          throw await invalidResult(
            state,
            registration,
            event,
            `Plugin ${event} transform result is missing input.`
          );
        }
      } else if (!("value" in result)) {
        throw await invalidResult(
          state,
          registration,
          event,
          `Plugin ${event} transform result is missing value.`
        );
      }
    }
    if (
      result.action === "block" &&
      "reason" in result &&
      result.reason !== undefined &&
      typeof result.reason !== "string"
    ) {
      throw await invalidResult(
        state,
        registration,
        event,
        `Plugin ${event} block reason must be a string.`
      );
    }
    return;
  }
  throw await invalidResult(
    state,
    registration,
    event,
    `Plugin ${event} handler returned an invalid result.`
  );
}

export async function throwHookFailure(
  state: PluginRuntimeState,
  registration: PluginRegistration,
  event: keyof PluginEventMap,
  cause: unknown
): Promise<never> {
  await reportPluginFailure(
    state.diagnostics,
    registration.index,
    "handler",
    cause,
    event
  );
  throw new PluginHookError(registration.index, event, cause);
}

async function invalidResult(
  state: PluginRuntimeState,
  registration: PluginRegistration,
  event: keyof PluginEventMap,
  message: string
): Promise<PluginHookError> {
  const cause = new TypeError(message);
  await reportPluginFailure(
    state.diagnostics,
    registration.index,
    "handler",
    cause,
    event
  );
  return new PluginHookError(registration.index, event, cause);
}
