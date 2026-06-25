import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryExecutionHost } from "../../platform/memory";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
} from "../../testing/llm-test-utils";
import { assistantMessage } from "../../testing/test-fixtures";
import { inspectDurableTurn } from "./durable-turn";

const generateTextMock = getGenerateTextMock();

describe("inspectDurableTurn queue lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps precreated run ownership on the same host and thread key", async () => {
    const Agent = await loadAgent();
    const host = createInMemoryExecutionHost();
    let completeBlockedTurn: (() => void) | undefined;
    const blockedTurnStarted = new Promise<void>((resolve) => {
      generateTextMock
        .mockImplementationOnce(
          () =>
            new Promise((complete) => {
              completeBlockedTurn = () => {
                complete({ responseMessages: [assistantMessage("FIRST")] });
              };
              resolve();
            })
        )
        .mockResolvedValueOnce({
          responseMessages: [assistantMessage("SECOND-B")],
        })
        .mockResolvedValueOnce({
          responseMessages: [assistantMessage("SECOND-A")],
        });
    });
    const threadKey = "shared-thread";
    const firstAgent = new Agent({ host, model: fakeModel });
    const secondAgent = new Agent({ host, model: fakeModel });
    const firstThread = firstAgent.thread(threadKey);
    const secondThread = secondAgent.thread(threadKey);

    const blockedTurn = await firstThread.send("keep this thread busy");
    const blockedDrain = collectRun(blockedTurn);
    await blockedTurnStarted;
    const queuedOnFirstThread = await firstThread.send("queue on first thread");
    const queuedDrain = collectRun(queuedOnFirstThread);
    const turnOnSecondThread = await secondThread.send("run on second thread");
    const secondDrain = collectRun(turnOnSecondThread);

    try {
      await expect
        .poll(
          async () => {
            const record = await host.store.turns.get(
              turnOnSecondThread.runId ?? ""
            );
            return record?.status;
          },
          { timeout: 1000 }
        )
        .toBe("completed");
    } finally {
      completeBlockedTurn?.();
      await Promise.allSettled([blockedDrain, queuedDrain, secondDrain]);
    }
  });

  it("marks a precreated queued turn cancelled when disposed before processing", async () => {
    const Agent = await loadAgent();
    const host = createInMemoryExecutionHost();
    let completeBlockedTurn: (() => void) | undefined;
    const blockedTurnStarted = new Promise<void>((resolve) => {
      generateTextMock
        .mockImplementationOnce(
          () =>
            new Promise((complete) => {
              completeBlockedTurn = () => {
                complete({ responseMessages: [assistantMessage("FIRST")] });
              };
              resolve();
            })
        )
        .mockResolvedValueOnce({
          responseMessages: [assistantMessage("SECOND")],
        });
    });
    const thread = new Agent({ host, model: fakeModel }).thread(
      "dispose-queued-thread"
    );

    const activeTurn = await thread.send("keep the thread busy");
    const activeDrain = collectRun(activeTurn);
    await blockedTurnStarted;
    const queuedTurn = await thread.send("cancel before processing");
    const queuedDrain = collectRun(queuedTurn);

    expect(queuedTurn.runId).toEqual(expect.any(String));

    await thread.dispose();
    completeBlockedTurn?.();
    const queuedEvents = await queuedDrain;
    await activeDrain;

    expect(queuedEvents.at(-1)).toMatchObject({ type: "turn-error" });
    await expect(
      inspectDurableTurn(host, queuedTurn.runId ?? "")
    ).resolves.toMatchObject({
      runId: queuedTurn.runId,
      state: "no-checkpoint",
      status: "cancelled",
      threadKey: "dispose-queued-thread",
      turn: {
        runId: queuedTurn.runId,
        status: "cancelled",
        threadKey: "dispose-queued-thread",
      },
    });
  });

  it("cancels a precreated run when dispose races with run creation", async () => {
    const Agent = await loadAgent();
    const host = createInMemoryExecutionHost();
    let releaseCreate: (() => void) | undefined;
    let precreatedRunId: string | undefined;
    const createStarted = new Promise<void>((resolve) => {
      const originalCreate = host.store.turns.create.bind(host.store.turns);
      vi.spyOn(host.store.turns, "create").mockImplementation(
        async (record) => {
          if (
            record.kind === "user-turn" &&
            record.threadKey === "precreate-race-thread"
          ) {
            precreatedRunId = record.runId;
            resolve();
            await new Promise<void>((release) => {
              releaseCreate = release;
            });
          }
          return await originalCreate(record);
        }
      );
    });
    generateTextMock.mockResolvedValueOnce({
      responseMessages: [assistantMessage("NEVER")],
    });
    const thread = new Agent({ host, model: fakeModel }).thread(
      "precreate-race-thread"
    );

    const sendPromise = thread.send("dispose while precreating");
    await createStarted;
    await thread.dispose();
    releaseCreate?.();

    await expect(sendPromise).rejects.toThrow();
    expect(precreatedRunId).toEqual(expect.any(String));
    await expect(
      inspectDurableTurn(host, precreatedRunId ?? "")
    ).resolves.toMatchObject({
      runId: precreatedRunId,
      state: "no-checkpoint",
      status: "cancelled",
      threadKey: "precreate-race-thread",
      turn: {
        runId: precreatedRunId,
        status: "cancelled",
      },
    });
  });
});
