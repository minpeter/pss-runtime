import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
} from "../../testing/llm-test-utils";
import { assistantMessage } from "../../testing/test-fixtures";
import { dispatchAgentNotification } from "../dispatch/notification-dispatch";
import { createInMemoryExecutionHost } from "../memory";
import { inspectDurableTurn } from "./durable-turn";

const generateTextMock = getGenerateTextMock();

describe("inspectDurableTurn active and resume lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  it("marks the active durable run cancelled when disposed before model output settles", async () => {
    const Agent = await loadAgent();
    const host = createInMemoryExecutionHost();
    const neverSettlingModelOutput = new Promise(() => undefined);
    generateTextMock.mockImplementationOnce(() => neverSettlingModelOutput);
    const thread = new Agent({ host, model: fakeModel }).thread(
      "active-dispose-thread"
    );

    const turn = await thread.send("start a hanging turn");
    expect(turn.runId).toEqual(expect.any(String));
    await expect
      .poll(async () => {
        const record = await host.store.turns.get(turn.runId ?? "");
        return record?.status;
      })
      .toBe("running");

    await thread.dispose();

    await expect(
      inspectDurableTurn(host, turn.runId ?? "")
    ).resolves.toMatchObject({
      runId: turn.runId,
      state: "no-checkpoint",
      status: "cancelled",
      threadKey: "active-dispose-thread",
      turn: {
        runId: turn.runId,
        status: "cancelled",
      },
    });
  });

  it("uses the dispatched notification run id for resumed notification processing", async () => {
    const Agent = await loadAgent();
    const host = createInMemoryExecutionHost();
    let completeNotification: (() => void) | undefined;
    const notificationStarted = new Promise<void>((resolve) => {
      generateTextMock.mockImplementationOnce(
        () =>
          new Promise((complete) => {
            completeNotification = () => {
              complete({ responseMessages: [assistantMessage("NOTIFIED")] });
            };
            resolve();
          })
      );
    });
    const dispatched = await dispatchAgentNotification({
      host,
      idempotencyKey: "resume-notification:1",
      input: { text: "Resume this notification", type: "user-input" },
      namespace: "agent-a",
      threadKey: "resume-notification-thread",
    });
    const agent = new Agent({ host, model: fakeModel, namespace: "agent-a" });

    const turn = await agent.resume(dispatched.runId);

    expect(turn?.runId).toBe(dispatched.runId);
    if (!turn) {
      throw new Error("Expected notification resume to return a turn");
    }
    const drain = collectRun(turn);
    await notificationStarted;
    await expect
      .poll(async () => {
        const record = await host.store.turns.get(dispatched.runId);
        return record?.status;
      })
      .toBe("running");

    completeNotification?.();
    await drain;

    await expect(
      inspectDurableTurn(host, dispatched.runId)
    ).resolves.toMatchObject({
      runId: dispatched.runId,
      state: "no-checkpoint",
      status: "completed",
      threadKey: "resume-notification-thread",
      turn: {
        kind: "notification",
        runId: dispatched.runId,
        status: "completed",
      },
    });
  });
});
