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
});
