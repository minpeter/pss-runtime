import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../../platform/memory";
import type { DurableBackgroundHost } from "./capabilities";
import { durableBackgroundHost, executionHost, threadHost } from "./host";

describe("execution host capability normalizers", () => {
  it("preserves split durable background host identity", () => {
    const aggregateHost = createInMemoryExecutionHost();
    const splitHost = {
      backgroundScheduler: aggregateHost.scheduler,
      checkpointStore: aggregateHost.store.checkpoints,
      eventStore: aggregateHost.store.events,
      kind: "durable-background",
      notificationInbox: aggregateHost.store.notifications,
      turnStore: aggregateHost.store.turns,
      threadStore: aggregateHost.store.threads,
      transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
    } satisfies DurableBackgroundHost;

    expect(durableBackgroundHost(splitHost)).toBe(splitHost);
  });

  it("normalizes durable background hosts into execution hosts", () => {
    const aggregateHost = createInMemoryExecutionHost();
    const splitHost = {
      backgroundScheduler: aggregateHost.scheduler,
      checkpointStore: aggregateHost.store.checkpoints,
      eventStore: aggregateHost.store.events,
      kind: "durable-background",
      notificationInbox: aggregateHost.store.notifications,
      turnStore: aggregateHost.store.turns,
      threadStore: aggregateHost.store.threads,
      transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
    } satisfies DurableBackgroundHost;

    expect(durableBackgroundHost(splitHost)).toBe(splitHost);
    expect(threadHost(splitHost).threadStore).toBe(aggregateHost.store.threads);
    const normalizedExecutionHost = executionHost(splitHost);

    expect(normalizedExecutionHost?.store.threads).toBe(
      aggregateHost.store.threads
    );
  });
});
