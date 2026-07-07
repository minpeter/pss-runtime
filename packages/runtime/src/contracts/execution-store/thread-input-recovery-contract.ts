import { expect, it } from "vitest";
import type { ClaimedThreadInput, ExecutionStore } from "../../execution";

export interface ThreadInputInboxRecoveryContractOptions {
  readonly createStore: () => ExecutionStore;
}

export function describeThreadInputInboxRecoveryContract({
  createStore,
}: ThreadInputInboxRecoveryContractOptions): void {
  it("claims a requested message id without consuming older pending inputs", async () => {
    const store = createStore();
    await store.inputs.admit({
      admittedAtMs: 1,
      input: { text: "older", type: "user-input" },
      kind: "send",
      messageId: "send-older",
      threadKey: "thread-1",
    });
    await store.inputs.admit({
      admittedAtMs: 2,
      input: { text: "newer", type: "user-input" },
      kind: "send",
      messageId: "send-newer",
      threadKey: "thread-1",
    });

    await expect(
      store.inputs.claimNext("thread-1", "turn-idle", {
        messageId: "send-newer",
      })
    ).resolves.toMatchObject({
      admittedSeq: 2,
      messageId: "send-newer",
    });
    await expect(
      store.inputs.claimNext("thread-1", "turn-idle")
    ).resolves.toMatchObject({
      admittedSeq: 1,
      messageId: "send-older",
    });
  });

  it("recovers claiming inputs as pending and promoted inputs as acked", async () => {
    const store = createStore();
    await store.inputs.admit({
      admittedAtMs: 1,
      input: { text: "claiming", type: "user-input" },
      kind: "send",
      messageId: "message-claiming",
      threadKey: "thread-1",
    });
    await store.inputs.admit({
      admittedAtMs: 2,
      input: { text: "promoted", type: "user-input" },
      kind: "send",
      messageId: "message-promoted",
      threadKey: "thread-1",
    });
    const claiming = await expectClaimed(
      store.inputs.claimNext("thread-1", "turn-idle")
    );
    const promotedClaim = await expectClaimed(
      store.inputs.claimNext("thread-1", "turn-idle")
    );
    await store.inputs.markPromoted(promotedClaim);

    await expect(store.inputs.recoverClaims("thread-1")).resolves.toEqual({
      acked: [
        expect.objectContaining({
          messageId: "message-promoted",
          status: "acked",
        }),
      ],
      released: [
        expect.objectContaining({
          messageId: "message-claiming",
          status: "pending",
        }),
      ],
    });
    const reclaimed = await expectClaimed(
      store.inputs.claimNext("thread-1", "turn-idle")
    );

    expect(reclaimed.messageId).toBe(claiming.messageId);
    expect(reclaimed.claimId).not.toBe(claiming.claimId);
    await expect(
      store.inputs.claimNext("thread-1", "turn-idle")
    ).resolves.toBeNull();
  });
}

async function expectClaimed(
  claim: Promise<ClaimedThreadInput | null>
): Promise<ClaimedThreadInput> {
  const claimed = await claim;
  expect(claimed).not.toBeNull();
  if (!claimed) {
    throw new Error("Expected a claimed thread input.");
  }
  return claimed;
}
