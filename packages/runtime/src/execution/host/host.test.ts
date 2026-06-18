import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "../memory";
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
      runStore: aggregateHost.store.runs,
      threadStore: aggregateHost.store.threads,
      transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
    } satisfies DurableBackgroundHost;

    expect(durableBackgroundHost(splitHost)).toBe(splitHost);
  });

  it("normalizes durable background hosts with only deprecated sessionStore", () => {
    const aggregateHost = createInMemoryExecutionHost();
    const legacySplitHost = {
      backgroundScheduler: aggregateHost.scheduler,
      checkpointStore: aggregateHost.store.checkpoints,
      eventStore: aggregateHost.store.events,
      kind: "durable-background",
      notificationInbox: aggregateHost.store.notifications,
      runStore: aggregateHost.store.runs,
      sessionStore: aggregateHost.store.threads,
      transaction: aggregateHost.store.transaction.bind(aggregateHost.store),
    } satisfies DurableBackgroundHost;

    expect(durableBackgroundHost(legacySplitHost)).toBe(legacySplitHost);
    expect(threadHost(legacySplitHost).threadStore).toBe(
      aggregateHost.store.threads
    );
    const normalizedExecutionHost = executionHost(legacySplitHost);

    expect(normalizedExecutionHost?.store.threads).toBe(
      aggregateHost.store.threads
    );
    expect(normalizedExecutionHost?.store.sessions).toBe(
      aggregateHost.store.threads
    );
  });
});
