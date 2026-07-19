import { describe, expect, it } from "vitest";
import type { TurnRecord } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { userText } from "../../testing/test-fixtures";
import { BufferedAgentTurn } from "../../thread/protocol/turn";
import { agentNamespace } from "../identity/namespace";
import { resumeAgentTurn } from "./resume";

describe("resumeAgentTurn access control", () => {
  it("denies runs that lack ownerNamespace even with parent-prefixed thread keys", async () => {
    const host = createInMemoryHost();
    const ownerNamespace = agentNamespace("coordinator");
    const runId = "orphan-run";
    const run: TurnRecord = {
      checkpointVersion: 0,
      dedupeKey: "orphan-dedupe",
      kind: "notification",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: `parent:${ownerNamespace}:subagent:child`,
    };
    await host.store.turns.create(run);

    await expect(
      resumeAgentTurn({
        host,
        ownerNamespace,
        resumeNotification: () => {
          throw new Error(
            "resumeNotification must not run without owner access"
          );
        },
        runId,
      })
    ).resolves.toBeNull();
  });

  it("allows runs whose ownerNamespace is owned by the resumer", async () => {
    const host = createInMemoryHost();
    const ownerNamespace = agentNamespace("coordinator");
    const runId = "owned-run";
    const childOwner = `${ownerNamespace}:thread:room%2F1:generation:1`;
    const run: TurnRecord = {
      checkpointVersion: 0,
      dedupeKey: "owned-dedupe",
      kind: "notification",
      ownerNamespace: childOwner,
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "default",
    };
    await host.store.turns.create(run);
    await host.store.notifications.enqueue({
      idempotencyKey: "owned-dedupe",
      input: userText("ready"),
      notificationId: "n1",
      ownerNamespace: childOwner,
      runId,
      status: "pending",
      threadKey: "default",
    });

    let resumed = false;
    const turn = new BufferedAgentTurn();
    turn.close();
    const result = await resumeAgentTurn({
      host,
      ownerNamespace,
      resumeNotification: () => {
        resumed = true;
        return Promise.resolve(turn);
      },
      runId,
    });

    expect(resumed).toBe(true);
    expect(result).toBe(turn);
  });
});
