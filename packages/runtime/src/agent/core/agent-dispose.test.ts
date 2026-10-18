import { describe, expect, it, vi } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { createDeferred } from "../../testing/async-fixtures";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { DisposedResourceError } from "../../thread/state/thread-errors";
import { Agent } from "./agent";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

describe("Agent.dispose", () => {
  it.each([undefined, null])(
    "preserves a %s thread disposal rejection",
    async (reason) => {
      const agent = new Agent({ model: fakeModel });
      const first = agent.thread("first-rejecting-disposal");
      const later = agent.thread("later-rejecting-disposal");
      vi.spyOn(first, "dispose").mockRejectedValue(reason);
      const laterDispose = vi
        .spyOn(later, "dispose")
        .mockRejectedValue(new Error("later disposal failure"));

      const outcome = await agent.dispose().then(
        () => ({ resolved: true }) as const,
        (rejection: unknown) => ({ rejection, resolved: false }) as const
      );

      expect(outcome).toEqual({ rejection: reason, resolved: false });
      expect(laterDispose).toHaveBeenCalledOnce();
      expect(agent.thread("first-rejecting-disposal")).toBe(first);
      expect(agent.thread("later-rejecting-disposal")).toBe(later);
    }
  );

  it("rejects commands after a successful disposal and stays idempotent", async () => {
    // Given: an agent that has been disposed successfully.
    const agent = new Agent({ model: fakeModel });
    agent.thread("before-dispose");
    await agent[Symbol.asyncDispose]();

    // When/Then: every command method rejects with DisposedResourceError.
    expect(() => agent.thread("after-dispose")).toThrow(DisposedResourceError);
    expect(() => agent.send("hello")).toThrow(DisposedResourceError);
    expect(() => agent.followUp("hello")).toThrow(DisposedResourceError);
    expect(() => agent.overlay("hello")).toThrow(DisposedResourceError);
    await expect(agent.resume("any-run")).rejects.toBeInstanceOf(
      DisposedResourceError
    );

    // Then: further disposal remains a no-op.
    await expect(agent.dispose()).resolves.toBeUndefined();
    await expect(agent[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("closes admission while thread cleanup is still pending", async () => {
    // Given: a disposal blocked on an existing thread's cleanup.
    const agent = new Agent({ model: fakeModel });
    const cleanup = createDeferred();
    vi.spyOn(agent.thread("slow-cleanup"), "dispose").mockReturnValue(
      cleanup.promise
    );
    const disposal = agent.dispose();

    // When/Then: a racing thread() call is rejected instead of admitted.
    expect(() => agent.thread("racing-thread")).toThrow(DisposedResourceError);
    expect(() => agent.send("hello")).toThrow(DisposedResourceError);
    expect(agent.dispose()).toBe(disposal);

    // Then: the pending disposal completes and admission stays closed.
    cleanup.resolve();
    await expect(disposal).resolves.toBeUndefined();
    expect(() => agent.thread("racing-thread")).toThrow(DisposedResourceError);
  });

  it("reopens admission after failed cleanup so dispose can be retried", async () => {
    // Given: a disposal whose thread cleanup fails once.
    const agent = new Agent({ model: fakeModel });
    const handle = agent.thread("flaky-cleanup");
    vi.spyOn(handle, "dispose")
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined);
    await expect(agent.dispose()).rejects.toThrow("cleanup failed");

    // When: the app uses the agent again and retries disposal.
    expect(agent.thread("flaky-cleanup")).toBe(handle);
    await expect(agent.dispose()).resolves.toBeUndefined();

    // Then: the retried disposal closes admission.
    expect(() => agent.thread("flaky-cleanup")).toThrow(DisposedResourceError);
  });

  it("rejects an in-flight resume whose thread entry is created after dispose starts", async () => {
    // Given: a recoverable run and a disposal blocked on thread cleanup.
    const host = createInMemoryHost();
    const runId = "resume-after-dispose-start";
    await host.store.turns.create({
      checkpointVersion: 0,
      dedupeKey: runId,
      kind: "user-turn",
      rootRunId: runId,
      runId,
      status: "queued",
      threadKey: "resume-race",
    });
    let modelCalls = 0;
    const agent = new Agent({
      host,
      model: createCallbackModel(() => {
        modelCalls += 1;
        return Promise.resolve([assistantMessage("RESUMED")]);
      }),
    });
    const cleanup = createDeferred();
    vi.spyOn(agent.thread("slow-cleanup"), "dispose").mockReturnValue(
      cleanup.promise
    );

    // When: resume is admitted, then dispose starts before resume's store work.
    const resumed = agent.resume(runId);
    const disposal = agent.dispose();

    // Then: resume rejects without running and the claimed run is requeued.
    await expect(resumed).rejects.toBeInstanceOf(DisposedResourceError);
    expect(modelCalls).toBe(0);
    const record = await host.store.turns.get(runId);
    expect(record?.status).toBe("queued");
    expect(record?.lease ?? null).toBeNull();
    cleanup.resolve();
    await expect(disposal).resolves.toBeUndefined();
  });
});
