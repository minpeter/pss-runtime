import { describe, expect, it } from "vitest";
import type { DurableBackgroundHost } from "./capabilities";
import { durableBackgroundHost } from "./host";
import { createInMemoryExecutionHost } from "./memory";

describe("execution host capability normalizers", () => {
  it("preserves split durable background host identity", () => {
    const aggregateHost = createInMemoryExecutionHost();
    const splitHost = {
      backgroundScheduler: aggregateHost.scheduler,
      capabilities: { backgroundSubagents: "durable" },
      checkpointStore: aggregateHost.store.checkpoints,
      eventStore: aggregateHost.store.events,
      notificationInbox: aggregateHost.store.notifications,
      runStore: aggregateHost.store.runs,
      sessionStore: aggregateHost.store.sessions,
      transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
    } satisfies DurableBackgroundHost;

    expect(durableBackgroundHost(splitHost)).toBe(splitHost);
  });
});
