import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../memory";
import type { DurableBackgroundHost } from "./capabilities";
import { durableBackgroundHost } from "./host";

describe("execution host capability normalizers", () => {
  it("preserves split durable background host identity", () => {
    const aggregateHost = createInMemoryExecutionHost();
    const splitHost = {
      backgroundScheduler: aggregateHost.scheduler,
      checkpointStore: aggregateHost.store.checkpoints,
      eventStore: aggregateHost.store.events,
      kind: "durable-background",
      notificationInbox: aggregateHost.store.notifications,
      runStore: aggregateHost.store.runs,
      sessionStore: aggregateHost.store.sessions,
      transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
    } satisfies DurableBackgroundHost;

    expect(durableBackgroundHost(splitHost)).toBe(splitHost);
  });
});
