import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { deferred } from "../../internal/deferred";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import { createInMemoryHost } from "../../platform/memory";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { collect } from "../handle/test-support";
import { decodeStoredThreadSnapshot } from "../state/snapshot";

const RECOVERY = /recovery/i;
const ADMISSION_RECOVERY = /admission requires recovery/i;

function fixture() {
  const host = createInMemoryHost();
  let calls = 0;
  const model = createMockLanguageModelV4(() => {
    calls += 1;
    if (calls <= 3) {
      throw new APICallError({
        message: "exhausted",
        requestBodyValues: {},
        responseHeaders: { "retry-after-ms": "0" },
        statusCode: 503,
        url: "https://fixture.invalid",
      });
    }
    return Promise.resolve(mockLanguageModelV4Text("finished"));
  });
  return { host, model, calls: () => calls };
}

describe("continuation ownership and failure boundaries", () => {
  it("does not turn tool recovery errors into request continuation", async () => {
    const { host, model, calls } = fixture();
    const thread = new Agent({
      host,
      model,
      prepareModelStep: () => {
        throw new ToolExecutionNeedsRecoveryError({
          attempt: 1,
          idempotencyKey: "tool-key",
          policy: "manual-recovery",
          toolCallId: "tool",
          toolName: "count",
        });
      },
    }).thread("tool-recovery");
    expect((await collect(await thread.send("original"))).at(-1)?.type).toBe(
      "turn-error"
    );
    await expect(thread.continue()).rejects.toThrow(RECOVERY);
    expect(calls()).toBe(0);
    await thread.dispose();
  });

  it("surfaces admission recovery without blindly resubmitting input", async () => {
    const { host, model, calls } = fixture();
    const thread = new Agent({ host, model }).thread("storage-error");
    const admit = vi
      .spyOn(host.store, "transaction")
      .mockRejectedValueOnce(new Error("storage offline"));
    await expect(thread.send("original")).rejects.toThrow("storage offline");
    admit.mockRestore();
    await expect(thread.continue()).rejects.toThrow(ADMISSION_RECOVERY);
    expect(calls()).toBe(0);
    await thread.dispose();
  });

  it("rejects busy continuation and resumes after interruption settles", async () => {
    const started = deferred();
    let attempts = 0;
    const model = createMockLanguageModelV4(async ({ abortSignal }) => {
      attempts += 1;
      if (attempts === 1) {
        started.resolve();
        await new Promise<void>((resolve) =>
          abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
        throw new DOMException("cancelled", "AbortError");
      }
      return { ...mockLanguageModelV4Text("finished") };
    });
    const thread = new Agent({ model }).thread("cancel");
    const completed = collect(await thread.send("original"));
    await started.promise;
    await expect(thread.continue()).rejects.toMatchObject({
      code: "THREAD_CONTINUATION_BUSY",
    });
    thread.interrupt();
    expect((await completed).at(-1)?.type).toBe("turn-abort");
    const resumed = await thread.continue();
    if (!resumed) {
      throw new Error("settled interruption lost its checkpoint");
    }
    expect((await collect(resumed)).at(-1)?.type).toBe("turn-end");
    expect(attempts).toBe(2);
    expect(await thread.continue()).toBeUndefined();
    await thread.dispose();
  });

  it("drains earlier durable input rather than applying stale progress", async () => {
    const { host, model, calls } = fixture();
    const completed = deferred();
    const original = host.store.transaction.bind(host.store);
    host.store.transaction = async (operation) =>
      await original(async (tx) => {
        const turns = tx.turns;
        return await operation({
          ...tx,
          turns: new Proxy(turns, {
            get(target, property) {
              if (property === "transition") {
                return async (
                  ...args: Parameters<NonNullable<typeof turns.transition>>
                ) => {
                  if (!turns.transition) {
                    throw new Error("Missing turn transition");
                  }
                  const result = await turns.transition(...args);
                  if (result.ok && result.record.status === "completed") {
                    completed.resolve();
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        });
      });
    const thread = new Agent({ host, model }).thread("ordered");
    await collect(await thread.send("A"));
    await host.store.inputs.admit({
      threadKey: "ordered",
      messageId: "B",
      kind: "send",
      input: { type: "user-input", text: "B" },
    });
    const continuation = await thread.continue();
    if (!continuation) {
      throw new Error("expected admission");
    }
    expect((await collect(continuation)).map((event) => event.type)).toEqual([
      "turn-abort",
    ]);
    await completed.promise;
    expect(calls()).toBe(4);
    const history = decodeStoredThreadSnapshot(
      await host.store.threads.load("ordered")
    );
    expect(history.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "B" },
    ]);
    await thread.dispose();
  });

  it("keeps the checkpoint if run admission storage fails", async () => {
    const { host, model, calls } = fixture();
    const thread = new Agent({ host, model }).thread("admission");
    await collect(await thread.send("A"));
    const create = vi
      .spyOn(host.store.turns, "create")
      .mockRejectedValueOnce(new Error("storage offline"));
    await expect(thread.continue()).rejects.toThrow("storage offline");
    create.mockRestore();
    const continuation = await thread.continue();
    if (!continuation) {
      throw new Error("checkpoint lost");
    }
    expect((await collect(continuation)).at(-1)?.type).toBe("turn-end");
    expect(calls()).toBe(4);
    await thread.dispose();
  });

  it("refreshes before applying a checkpoint when another handle changed history", async () => {
    const { host, model, calls } = fixture();
    const a = new Agent({ host, model }).thread("shared");
    await collect(await a.send("A"));
    const b = new Agent({ host, model }).thread("shared");
    await collect(await b.send("B"));
    const continuation = await a.continue();
    if (continuation) {
      await collect(continuation);
    }
    expect(calls()).toBe(4);
    expect(
      decodeStoredThreadSnapshot(
        await host.store.threads.load("shared")
      ).filter((message) => message.role === "user")
    ).toEqual([{ role: "user", content: "B" }]);
    expect(await a.continue()).toBeUndefined();
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it("isolates another session and keeps stopped work continuable after interrupt", async () => {
    const { host, model } = fixture();
    const agent = new Agent({ host, model });
    const a = agent.thread("A");
    await collect(await a.send("original"));
    const b = agent.thread("B");
    expect(await b.continue()).toBeUndefined();
    a.interrupt();
    const resumed = await a.continue();
    if (!resumed) {
      throw new Error("idle interruption lost its checkpoint");
    }
    expect((await collect(resumed)).at(-1)?.type).toBe("turn-end");
    await a.dispose();
    const loaded = new Agent({ host, model }).thread("A");
    expect(await loaded.continue()).toBeUndefined();
    await Promise.all([b.dispose(), loaded.dispose()]);
  });
});
