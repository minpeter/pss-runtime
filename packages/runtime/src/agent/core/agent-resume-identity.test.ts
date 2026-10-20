import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import {
  assistantMessage,
  createCallbackModel,
  userText,
} from "../../testing/test-fixtures";
import { collect } from "../../thread/handle/test-support";
import { agentNamespace } from "../identity/namespace";
import { notificationRunRecord } from "../resume/notification-resume.test-support";
import { Agent } from "./agent";
import { threadIdentityFromStoreKey } from "./thread-entry";

async function resumeNotificationOn(threadKey: string): Promise<Agent> {
  const host = createInMemoryHost();
  const agent = new Agent({
    host,
    model: createCallbackModel(() =>
      Promise.resolve([assistantMessage("NOTIFIED")])
    ),
    namespace: "identity-owner",
  });
  const ownerNamespace = agentNamespace("identity-owner");
  const runId = "notification-run-identity";
  const idempotencyKey = "background-complete:identity";
  await host.store.notifications.enqueue({
    idempotencyKey,
    input: userText("background task is ready"),
    notificationId: "notification-identity",
    ownerNamespace,
    runId,
    status: "pending",
    threadKey,
  });
  await host.store.turns.create({
    ...notificationRunRecord({ idempotencyKey, ownerNamespace, runId }),
    threadKey,
  });
  const turn = await agent.resume(runId);
  if (turn === null) {
    throw new Error("Expected notification resume to return a turn.");
  }
  await collect(turn);
  return agent;
}

describe("thread identity after agent.resume", () => {
  it("keeps the scoped identity when resume creates the thread entry first", async () => {
    // Given: a durable notification run on a scoped thread, resumed first.
    const agent = await resumeNotificationOn("scope:org:thread:t");

    // When: the app later addresses the same thread by its scoped identity.
    const thread = agent.thread({ id: "t", scope: "org" });

    // Then: the cached handle reports the app identity, not the store key.
    expect(thread.identity).toEqual({ id: "t", scope: "org" });
  });

  it("keeps a malformed-escape store key verbatim without throwing", async () => {
    // Given: a durable run whose store key cannot be percent-decoded.
    const key = "scope:%E0%A4%A:thread:t";

    // When: resume creates the thread entry from that key.
    const agent = await resumeNotificationOn(key);

    // Then: the handle identity falls back to the verbatim key.
    expect(agent.thread(key).identity).toEqual({ id: key });
  });

  it.each([
    ["scope:user%3A1:thread:room%2F1", { id: "room/1", scope: "user:1" }],
    ["scope::thread:", { id: "", scope: "" }],
    ["default", { id: "default" }],
    ["scope:a:b:thread:t", { id: "scope:a:b:thread:t" }],
    ["scope:org:thread:%ZZ", { id: "scope:org:thread:%ZZ" }],
  ])("reverses store key %s", (key, identity) => {
    // Given/When: a store key read back from a durable record is parsed.
    // Then: encoded scoped keys decode; anything else stays verbatim.
    expect(threadIdentityFromStoreKey(key)).toEqual(identity);
  });
});
