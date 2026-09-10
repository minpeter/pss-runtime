import { expect, it, vi } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { createQueuedSendInput } from "../handle/durable-queue-send";
import { collect } from "../handle/test-support";
import { runThreadInputDrainLoop } from "../handle/thread-drain";
import {
  createRuntimeInputState,
  type QueuedInput,
} from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadState } from "../state/thread-state";
import { createDispatcher } from "./nonterminal-ownership-test-support";

it("retains later callers when execution start never acquired authority", async () => {
  const host = createInMemoryHost();
  const threadKey = "start-failure";
  const state = new ThreadState({ key: threadKey, store: host.store.threads });
  const makeItem = (text: string): QueuedInput => ({
    initialEvents: [],
    input: userText(text),
    preUserRuntimeInputs: [],
    run: new BufferedAgentTurn(),
    runtimeInput: createRuntimeInputState([]),
  });
  const first = makeItem("FIRST");
  const later = makeItem("LATER");
  const events = createDispatcher(host, state, threadKey);
  const admitted = await createQueuedSendInput({
    awaitBoundaries: true,
    attachmentStore: host.attachmentStore,
    events,
    executionHost: host,
    input: "LATER",
    pendingOverlays: [],
    pendingRuntimeInputs: [],
    run: later.run,
    threadKey,
  });
  if (admitted.kind !== "queued") {
    throw new Error("Expected durable admission");
  }
  Object.assign(later, admitted.item);
  const inputQueue = [first, later];
  const firstEvents = collect(first.run);
  const laterEvents = collect(later.run);
  const create = vi
    .spyOn(host.store.turns, "create")
    .mockRejectedValueOnce(new Error("START_OFFLINE"));
  const model = vi.fn(() => Promise.resolve([assistantMessage("DONE")]));
  const options = {
    activate: () => undefined,
    continueDraining: () => true,
    deactivateRun: () => undefined,
    events,
    execution: { executionHost: host },
    inputQueue,
    model: { model: createCallbackModel(model) },
    release: () => undefined,
    state,
    threadKey,
  };
  try {
    await runThreadInputDrainLoop(options);
    expect((await firstEvents).at(-1)?.type).toBe("turn-error");
    expect(inputQueue).toEqual([later]);
    expect(later.runtimeInput.closedReason).toBeUndefined();
    expect((await host.store.turns.get(later.run.runId ?? ""))?.status).toBe(
      "queued"
    );
    expect(state.continuationCheckpoint()).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    await runThreadInputDrainLoop(options);
    expect((await laterEvents).at(-1)?.type).toBe("turn-end");
    expect(model).toHaveBeenCalledOnce();
    expect((await host.store.turns.get(later.run.runId ?? ""))?.status).toBe(
      "completed"
    );
  } finally {
    create.mockRestore();
    first.run.close();
    later.run.close();
    await Promise.all([firstEvents, laterEvents]);
  }
});
