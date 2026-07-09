import { describe, expect, it } from "vitest";
import type { AgentHost, HostStoreTransaction } from "../../execution";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import { ThreadState } from "../state/thread-state";
import { commitAndAckDurableThreadInput } from "./durable-inputs";

describe("durable input atomic commits", () => {
  it("rolls back thread commit when durable input ack fails", async () => {
    const base = createInMemoryHost();
    const threadKey = "durable-atomic";
    await base.store.inputs.admit({
      input: userText("atomic"),
      kind: "send",
      messageId: "atomic-message",
      threadKey,
    });
    const claim = await base.store.inputs.claimNext(threadKey, "turn-idle");
    if (!claim) {
      throw new Error("expected input claim");
    }
    const state = new ThreadState({
      key: threadKey,
      store: base.store.threads,
    });
    await state.ensureLoaded();
    state.appendUserInput(claim.input);

    await expect(
      commitAndAckDurableThreadInput({
        buffer: [],
        executionHost: executionHostWithFailingAck(base),
        record: claim,
        state,
        threadKey,
      })
    ).rejects.toThrow("ack failed");

    await expect(base.store.threads.load(threadKey)).resolves.toBeNull();
    await expect(base.store.inputs.recoverClaims(threadKey)).resolves.toEqual({
      acked: [],
      released: [
        expect.objectContaining({
          messageId: "atomic-message",
          status: "pending",
        }),
      ],
    });
  });
});

function executionHostWithFailingAck(base: AgentHost): AgentHost {
  return {
    scheduler: base.scheduler,
    store: {
      checkpoints: base.store.checkpoints,
      events: base.store.events,
      inputs: base.store.inputs,
      notifications: base.store.notifications,
      threads: base.store.threads,
      transaction: (fn) =>
        base.store.transaction(
          async (tx) => await fn(transactionWithFailingAck(tx))
        ),
      turns: base.store.turns,
    },
  };
}

function transactionWithFailingAck(
  tx: HostStoreTransaction
): HostStoreTransaction {
  return {
    checkpoints: tx.checkpoints,
    events: tx.events,
    inputs: {
      ack: () => Promise.reject(new Error("ack failed")),
      admit: (input) => tx.inputs.admit(input),
      claimNext: (threadKey, boundary, options) =>
        tx.inputs.claimNext(threadKey, boundary, options),
      markPromoted: (record) => tx.inputs.markPromoted(record),
      recoverClaims: (threadKey) => tx.inputs.recoverClaims(threadKey),
      releaseClaim: (record) => tx.inputs.releaseClaim(record),
    },
    notifications: tx.notifications,
    threads: tx.threads,
    turns: tx.turns,
  };
}
