import type { PluginEventMap, PluginHandler, Subscription } from "./api";
import { PluginRegistrationClosedError } from "./plugin-errors";
import { subscriptionFor } from "./plugin-subscription";
import type {
  PluginRegistration,
  PluginRuntimeState,
  RegisteredHandler,
} from "./plugin-types";

export function createRegistration(index: number): PluginRegistration {
  return {
    handlers: [],
    index,
    state: "loading",
    subscriptions: [],
    tools: new Map(),
  };
}

export function registerHandler<E extends keyof PluginEventMap>(
  registration: PluginRegistration,
  event: E,
  handler: PluginHandler<E>
): Subscription {
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
}

export function activateRegistration(
  state: PluginRuntimeState,
  registration: PluginRegistration
): void {
  registration.state = "active";
  state.registrations.push(registration);
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

export function assertLoading(registration: PluginRegistration): void {
  if (registration.state !== "loading") {
    throw new PluginRegistrationClosedError(registration.index);
  }
}
