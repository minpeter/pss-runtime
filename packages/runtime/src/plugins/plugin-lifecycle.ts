import type { PluginAPI, PluginCapability, PluginDefinition } from "./api";
import { provideCapability, publishCapabilities } from "./plugin-capabilities";
import { PluginInitializationError } from "./plugin-errors";
import { withTimeout } from "./plugin-invocation";
import {
  activateRegistration,
  createRegistration,
  registerHandler,
} from "./plugin-registry";
import type {
  PluginFailureReporter,
  PluginRegistration,
  PluginRuntimeOptions,
  PluginRuntimeState,
} from "./plugin-types";

export function createRuntimeState(
  options: PluginRuntimeOptions,
  reportPluginFailure: PluginFailureReporter
): PluginRuntimeState {
  return {
    abort: new AbortController(),
    diagnostics: options.diagnostics,
    hookTimeoutMs: options.hookTimeoutMs,
    registrations: [],
    reportPluginFailure,
    threadStateClearers: new Set(),
    tools: { ...(options.tools ?? {}) },
  };
}

export async function loadPlugin(
  state: PluginRuntimeState,
  factory: PluginDefinition,
  index: number,
  timeoutMs: number
): Promise<void> {
  const registration = createRegistration(index);
  const factoryAbort = new AbortController();
  const factorySignal = AbortSignal.any([
    state.abort.signal,
    factoryAbort.signal,
  ]);
  try {
    await withTimeout(
      Promise.resolve(
        factory(pluginApi(state, registration), { signal: factorySignal })
      ),
      timeoutMs,
      factorySignal
    );
    publishCapabilities(state, registration);
    activateRegistration(state, registration);
  } catch (cause) {
    factoryAbort.abort(cause);
    disposeRegistration(registration);
    await state.reportPluginFailure(index, "factory", cause);
    throw new PluginInitializationError(index, cause);
  }
}

export function clearThreadState(
  state: PluginRuntimeState,
  threadKey: string
): void {
  for (const clear of state.threadStateClearers) {
    clear(threadKey);
  }
}

export function disposeRuntime(state: PluginRuntimeState): Promise<void> {
  state.abort.abort();
  for (const registration of state.registrations) {
    disposeRegistration(registration);
  }
  state.registrations.length = 0;
  return Promise.resolve();
}

function pluginApi(
  state: PluginRuntimeState,
  registration: PluginRegistration
): PluginAPI {
  return {
    on: (event, handler) => registerHandler(registration, event, handler),
    provide: ((capability: PluginCapability) =>
      provideCapability(
        state,
        registration,
        capability
      )) as PluginAPI["provide"],
  };
}

function disposeRegistration(registration: PluginRegistration): void {
  registration.state = "disposed";
  for (const subscription of registration.subscriptions) {
    subscription.unsubscribe();
  }
}
