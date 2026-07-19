import type { Subscription } from "./api";

export function subscriptionFor(dispose: () => void): Subscription {
  let active = true;
  return {
    unsubscribe: () => {
      if (!active) {
        return;
      }
      active = false;
      dispose();
    },
  };
}
