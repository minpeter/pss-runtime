import type {
  PluginAPI,
  PluginCapability,
  PluginDefinition,
  PluginEventMap,
  PluginHandler,
  ThreadScopeCapability,
  ThreadStateHandle,
} from "./api";
import {
  PluginInitializationError,
  PluginRegistrationClosedError,
} from "./plugin-errors";
import { subscriptionFor } from "./plugin-helpers";
import { reportPluginFailure } from "./plugin-report";
import { withTimeout } from "./plugin-timeout";
import type {
  PluginRegistration,
  PluginRuntimeOptions,
  PluginRuntimeState,
  RegisteredHandler,
} from "./plugin-types";

export function createRuntimeState(
  options: PluginRuntimeOptions
): PluginRuntimeState {
  return {
    abort: new AbortController(),
    diagnostics: options.diagnostics,
    hookTimeoutMs: options.hookTimeoutMs,
    registrations: [],
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
  const registration: PluginRegistration = {
    handlers: [],
    index,
    state: "loading",
    subscriptions: [],
    tools: new Map(),
  };
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
    publish(state, registration);
    registration.state = "active";
    state.registrations.push(registration);
  } catch (cause) {
    factoryAbort.abort(cause);
    registration.state = "disposed";
    for (const subscription of registration.subscriptions) {
      subscription.unsubscribe();
    }
    await reportPluginFailure(state.diagnostics, index, "factory", cause);
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
    registration.state = "disposed";
    for (const subscription of registration.subscriptions) {
      subscription.unsubscribe();
    }
  }
  state.registrations.length = 0;
  return Promise.resolve();
}

export function* activeHandlers<E extends keyof PluginEventMap>(
  state: PluginRuntimeState,
  event: E
): Generator<{
  readonly registered: RegisteredHandler;
  readonly registration: PluginRegistration;
}> {
  for (const registration of state.registrations) {
    if (registration.state !== "active") {
      continue;
    }
    for (const registered of registration.handlers) {
      if (registered.active && registered.event === event) {
        yield { registered, registration };
      }
    }
  }
}

function pluginApi(
  state: PluginRuntimeState,
  registration: PluginRegistration
): PluginAPI {
  return {
    on: (event, handler) => {
      assertLoading(registration);
      const registered: RegisteredHandler = {
        active: true,
        event,
        handler: handler as unknown as PluginHandler<keyof PluginEventMap>,
      };
      registration.handlers.push(registered);
      const subscription = subscriptionFor(() => {
        registered.active = false;
      });
      registration.subscriptions.push(subscription);
      return subscription;
    },
    provide: ((capability: PluginCapability) => {
      assertLoading(registration);
      if (capability.kind === "thread-scope") {
        return threadScope(state, capability);
      }
      if (capability.kind === "tool") {
        if (registration.tools.has(capability.name)) {
          throw new TypeError(
            `Duplicate tool name ${JSON.stringify(capability.name)}.`
          );
        }
        registration.tools.set(capability.name, capability);
      } else {
        throw new TypeError("Unknown plugin capability.");
      }
      const subscription = subscriptionFor(() => {
        registration.tools.delete(capability.name);
        if (state.tools[capability.name] === capability.tool) {
          delete state.tools[capability.name];
        }
      });
      registration.subscriptions.push(subscription);
      return subscription;
    }) as PluginAPI["provide"],
  };
}

function assertLoading(registration: PluginRegistration): void {
  if (registration.state !== "loading") {
    throw new PluginRegistrationClosedError(registration.index);
  }
}

function threadScope<T>(
  state: PluginRuntimeState,
  capability: ThreadScopeCapability<T>
): ThreadStateHandle<T> {
  const states = new Map<string, T>();
  state.threadStateClearers.add((key) => states.delete(key));
  return {
    get: (thread) => {
      if (!states.has(thread.key)) {
        states.set(thread.key, capability.create());
      }
      return states.get(thread.key) as T;
    },
  };
}

function publish(
  state: PluginRuntimeState,
  registration: PluginRegistration
): void {
  for (const name of registration.tools.keys()) {
    if (name in state.tools) {
      throw new TypeError(`Duplicate tool name ${JSON.stringify(name)}.`);
    }
  }
  for (const [name, capability] of registration.tools) {
    state.tools[name] = capability.tool;
  }
}
