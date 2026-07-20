import type {
  PluginCapability,
  Subscription,
  ThreadScopeCapability,
  ThreadStateHandle,
} from "./api";
import { assertLoading } from "./plugin-registry";
import { subscriptionFor } from "./plugin-subscription";
import type { PluginRegistration, PluginRuntimeState } from "./plugin-types";

export function provideCapability(
  state: PluginRuntimeState,
  registration: PluginRegistration,
  capability: PluginCapability
): Subscription | ThreadStateHandle<unknown> {
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
}

export function publishCapabilities(
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
