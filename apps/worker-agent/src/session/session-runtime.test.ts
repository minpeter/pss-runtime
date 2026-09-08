import type { ThreadEventReadOptions } from "@minpeter/pss-runtime";
import type {
  AgentHost,
  HostStoreTransaction,
} from "@minpeter/pss-runtime/execution";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { describe, expect, it } from "vitest";

import {
  replayDurableThreadEvents,
  submitDurableSessionTurn,
} from "./session-runtime";

describe("durable session runtime adapter", () => {
  it("returns the runtime run id immediately after durable admission", async () => {
    const host = createInMemoryHost();

    const admitted = await submitDurableSessionTurn({
      host,
      idempotencyKey: "client-turn-1",
      input: "hello",
      namespace: "worker-agent",
      threadKey: "default",
    });

    expect(admitted).toEqual({
      accepted: true,
      runId: expect.any(String),
      threadKey: "default",
    });
    await expect(host.store.turns.get(admitted.runId)).resolves.toMatchObject({
      runId: admitted.runId,
      status: "queued",
      threadKey: "default",
    });
  });

  it("omits eventCursor unless the durable admission returns one", async () => {
    const host = createInMemoryHost();

    const admitted = await submitDurableSessionTurn({
      host,
      idempotencyKey: "client-turn-cursor",
      input: "hello",
      namespace: "worker-agent",
      threadKey: "default",
    });

    expect("eventCursor" in admitted).toBe(false);
  });

  it("collapses a repeated idempotencyKey into exactly one durable admission", async () => {
    const { admissions, host } = countingAdmissionHost();

    const first = await submitDurableSessionTurn({
      host,
      idempotencyKey: "client-turn-dup",
      input: "hello",
      namespace: "worker-agent",
      threadKey: "default",
    });
    const second = await submitDurableSessionTurn({
      host,
      idempotencyKey: "client-turn-dup",
      input: "hello",
      namespace: "worker-agent",
      threadKey: "default",
    });

    expect(second.runId).toBe(first.runId);
    expect(second.threadKey).toBe(first.threadKey);
    expect(admissions.count).toBe(1);
  });

  it("admits distinct runs for different idempotency keys", async () => {
    const { admissions, host } = countingAdmissionHost();

    const first = await submitDurableSessionTurn({
      host,
      idempotencyKey: "client-turn-a",
      input: "hello",
      namespace: "worker-agent",
      threadKey: "default",
    });
    const second = await submitDurableSessionTurn({
      host,
      idempotencyKey: "client-turn-b",
      input: "hello",
      namespace: "worker-agent",
      threadKey: "default",
    });

    expect(second.runId).not.toBe(first.runId);
    expect(admissions.count).toBe(2);
  });

  it("gap-fills committed runtime events strictly after the cursor", async () => {
    const host = createInMemoryHost();
    const eventLog = host.store.threadEvents;
    if (!eventLog) {
      throw new Error("expected runtime thread event replay");
    }
    const firstCursor = await eventLog.append("default", {
      type: "turn-start",
    });
    const secondCursor = await eventLog.append("default", {
      text: "one",
      type: "assistant-output",
    });
    const lastCursor = await eventLog.append("default", { type: "turn-end" });

    const replayed = await replayDurableThreadEvents(
      {
        events: (options) => eventLog.read("default", options),
      },
      { after: firstCursor, limit: 10 }
    );

    expect(replayed).toEqual({
      events: [
        {
          cursor: secondCursor,
          event: { text: "one", type: "assistant-output" },
          threadKey: "default",
        },
        {
          cursor: lastCursor,
          event: { type: "turn-end" },
          threadKey: "default",
        },
      ],
      nextCursor: lastCursor,
    });
  });

  it("omits nextCursor for an empty page at the end of the log", async () => {
    const host = createInMemoryHost();
    const eventLog = host.store.threadEvents;
    if (!eventLog) {
      throw new Error("expected runtime thread event replay");
    }
    const lastCursor = await eventLog.append("default", { type: "turn-end" });

    const replayed = await replayDurableThreadEvents(
      {
        events: (options) => eventLog.read("default", options),
      },
      { after: lastCursor }
    );

    expect(replayed).toEqual({ events: [] });
    expect("nextCursor" in replayed).toBe(false);
  });

  it("caps the default page at the replay limit and paginates gaplessly", async () => {
    const host = createInMemoryHost();
    const eventLog = host.store.threadEvents;
    if (!eventLog) {
      throw new Error("expected runtime thread event replay");
    }
    const total = 120;
    for (let index = 0; index < total; index += 1) {
      await eventLog.append("default", {
        text: `event-${index}`,
        type: "assistant-output",
      });
    }
    const readPage = (options?: ThreadEventReadOptions) =>
      replayDurableThreadEvents(
        {
          events: (readOptions) => eventLog.read("default", readOptions),
        },
        options
      );

    const firstPage = await readPage();
    expect(firstPage.events).toHaveLength(100);
    expect(firstPage.events.map((event) => event.cursor.offset)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1)
    );
    expect(firstPage.nextCursor).toEqual(
      firstPage.events.at(-1)?.cursor ?? null
    );
    if (!firstPage.nextCursor) {
      throw new Error("expected a nextCursor on a full page");
    }

    const secondPage = await readPage({
      after: firstPage.nextCursor,
    });
    expect(secondPage.events).toHaveLength(20);
    expect(secondPage.nextCursor).toEqual(
      secondPage.events.at(-1)?.cursor ?? null
    );
    if (!secondPage.nextCursor) {
      throw new Error("expected a nextCursor on the final partial page");
    }

    const thirdPage = await readPage({
      after: secondPage.nextCursor,
    });
    expect(thirdPage).toEqual({ events: [] });
    expect("nextCursor" in thirdPage).toBe(false);

    const offsets = [...firstPage.events, ...secondPage.events].map(
      (event) => event.cursor.offset
    );
    expect(offsets).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );
    expect(new Set(offsets).size).toBe(total);
  });
});

/** Counts durable turn admissions passing through the host transaction. */
function countingAdmissionHost(): {
  readonly admissions: { count: number };
  readonly host: AgentHost;
} {
  const host = createInMemoryHost();
  const admissions = { count: 0 };
  const store: AgentHost["store"] = {
    ...host.store,
    transaction: <T>(fn: (tx: HostStoreTransaction) => Promise<T>) =>
      host.store.transaction((tx) =>
        fn({
          ...tx,
          turns: {
            ...tx.turns,
            create: (record) => {
              admissions.count += 1;
              return tx.turns.create(record);
            },
          },
        })
      ),
  };
  return { admissions, host: { ...host, store } };
}
