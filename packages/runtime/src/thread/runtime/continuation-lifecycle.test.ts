import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transitionTurn } from "../../execution/host/turn-status";
import { deferred } from "../../internal/deferred";
import { createFileHost } from "../../platform/file";
import { createInMemoryHost } from "../../platform/memory";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { queueAgentThreadInput } from "../handle/agent-thread-admission";
import { createAgentThreadContext } from "../handle/agent-thread-context";
import { continueAgentThread } from "../handle/agent-thread-continuation";
import { drainAgentThreadInputQueue } from "../handle/agent-thread-drain";
import { killAgentThread } from "../handle/agent-thread-kill";
import { DurableInputRecoveryState } from "../handle/durable-queue-claims";
import { withThreadDrainOwnership } from "../handle/thread-drain-coordinator";
import type { AgentEvent } from "../protocol/events";
import type { AgentTurn } from "../protocol/turn";
import {
  decodeStoredThreadSnapshot,
  encodeThreadSnapshot,
} from "../state/snapshot";
import { queueThreadNotification } from "./notification";

const RECOVERY = /recovery/i;

async function collect(turn: AgentTurn | undefined): Promise<AgentEvent[]> {
  assert.ok(turn);
  const events: AgentEvent[] = [];
  for await (const event of turn.events()) {
    events.push(event);
  }
  return events;
}

for (const kind of ["memory", "file"] as const) {
  describe(`continuation lifecycle (${kind})`, () => {
    async function fixture() {
      const directory = await mkdtemp(
        join(tmpdir(), "continuation-lifecycle-")
      );
      const host =
        kind === "file" ? createFileHost({ directory }) : createInMemoryHost();
      let calls = 0;
      const prompts: unknown[] = [];
      let duringModel: (() => Promise<void>) | undefined;
      const context = createAgentThreadContext(
        {
          model: createMockLanguageModelV4(async (request) => {
            prompts.push(structuredClone(request.prompt));
            if (++calls === 1) {
              throw new Error("PHYSICAL_FAILURE");
            }
            await duringModel?.();
            return mockLanguageModelV4Text("DONE");
          }),
        },
        { key: "thread", store: host.store.threads },
        { executionHost: host }
      );
      await collect(await queueAgentThreadInput(context, "ORIGINAL", "send"));
      if (context.drain.state.tag === "draining") {
        await context.drain.state.promise;
      }
      async function holdDrain() {
        const entered = deferred();
        const release = deferred();
        const owned = withThreadDrainOwnership(
          host,
          context.threadKey,
          {},
          async () => {
            entered.resolve();
            await release.promise;
          }
        );
        await entered.promise;
        return { release: release.resolve, owned };
      }
      async function externalWrite() {
        const stored = await host.store.threads.load(context.threadKey);
        if (!stored) {
          throw new Error("missing stored thread");
        }
        const result = await host.store.threads.commit(
          context.threadKey,
          {
            state: encodeThreadSnapshot([
              { role: "user", content: "EXTERNAL_B" },
            ]),
          },
          { expectedVersion: stored.version }
        );
        expect(result.ok).toBe(true);
      }
      return {
        context,
        host,
        prompts,
        holdDrain,
        externalWrite,
        calls: () => calls,
        duringModel: (callback: () => Promise<void>) => {
          duringModel = callback;
        },
        cleanup: async () => {
          const drain = context.drain.state;
          await killAgentThread(context);
          if (drain.tag === "draining") {
            await drain.promise;
          }
          await rm(directory, { force: true, recursive: true });
        },
      };
    }

    it("B1: earlier durable input does not attach its output to the superseded continuation", async () => {
      const f = await fixture();
      try {
        await f.host.store.inputs.admit({
          threadKey: "thread",
          messageId: "B",
          kind: "send",
          input: { type: "user-input", text: "B" },
        });
        const run = await continueAgentThread(f.context);
        expect(run).toBeDefined();
        const events = await collect(run);
        if (f.context.drain.state.tag === "draining") {
          await f.context.drain.state.promise;
        }
        expect(events.map((event) => event.type)).toEqual(["turn-abort"]);
        expect((await f.host.store.turns.get(runId(run)))?.status).toBe(
          "cancelled"
        );
        expect(f.calls()).toBe(2);
        expect(
          decodeStoredThreadSnapshot(
            await f.host.store.threads.load("thread")
          ).filter((message) => message.role === "user")
        ).toEqual([{ role: "user", content: "B" }]);
      } finally {
        await f.cleanup();
      }
    });

    it("B1: a version change while accepted produces a terminal cancellation without inference", async () => {
      const f = await fixture();
      const gate = await f.holdDrain();
      try {
        const run = await continueAgentThread(f.context);
        await f.externalWrite();
        const done = collect(run);
        gate.release();
        await gate.owned;
        expect((await done).map((event) => event.type)).toEqual(["turn-abort"]);
        expect(f.calls()).toBe(1);
      } finally {
        gate.release();
        await gate.owned;
        await f.cleanup();
      }
    });

    it("B2: a transient claim failure removes the failed control and the next Enter retries the exact task", async () => {
      const f = await fixture();
      const original = f.host.store.inputs.claimNext.bind(f.host.store.inputs);
      let once = true;
      f.host.store.inputs.claimNext = async (...args) => {
        if (once) {
          once = false;
          throw new Error("CLAIM_OFFLINE");
        }
        return await original(...args);
      };
      try {
        const run = await continueAgentThread(f.context);
        expect((await collect(run)).map((event) => event.type)).toEqual([
          "turn-error",
        ]);
        expect(f.context.inputQueue).toHaveLength(0);
        expect((await f.host.store.turns.get(runId(run)))?.status).toBe(
          "cancelled"
        );
        const retried = await continueAgentThread(f.context);
        expect(retried).toBeDefined();
        expect((await collect(retried)).at(-1)?.type).toBe("turn-end");
        expect(f.calls()).toBe(2);
        expect(f.prompts[1]).toEqual(f.prompts[0]);
      } finally {
        f.host.store.inputs.claimNext = original;
        await f.cleanup();
      }
    });

    it("B3: later same-handle B supersedes the queued control without an ownership cycle", async () => {
      const f = await fixture();
      const gate = await f.holdDrain();
      try {
        const continued = await continueAgentThread(f.context);
        const sent = await queueAgentThreadInput(f.context, "LATER_B", "send");
        const aDone = collect(continued);
        const bDone = collect(sent);
        const drain = f.context.drain.state;
        expect(drain.tag).toBe("draining");
        gate.release();
        await gate.owned;
        if (drain.tag === "draining") {
          await drain.promise;
        }
        expect(f.context.inputQueue).toHaveLength(0);
        expect((await aDone).map((event) => event.type)).toEqual([
          "turn-abort",
        ]);
        expect((await bDone).at(-1)?.type).toBe("turn-end");
        expect(f.calls()).toBe(2);
        expect((await f.host.store.turns.get(runId(sent)))?.status).toBe(
          "completed"
        );
      } finally {
        gate.release();
        await gate.owned;
        await f.cleanup();
      }
    });

    it("B4: a write during queued-run creation is fenced before any stale inference", async () => {
      const f = await fixture();
      const entered = deferred();
      const release = deferred();
      const original = f.host.store.turns.create.bind(f.host.store.turns);
      f.host.store.turns.create = async (...args) => {
        const result = await original(...args);
        if (args[0].status === "queued") {
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      const pending = continueAgentThread(f.context);
      try {
        await entered.promise;
        await f.externalWrite();
        release.resolve();
        const run = await pending;
        expect((await collect(run)).at(-1)?.type).toBe("turn-abort");
        expect(f.calls()).toBe(1);
      } finally {
        release.resolve();
        f.host.store.turns.create = original;
        await f.cleanup();
      }
    });

    it("B4: a conflict recovery sentinel survives its terminal version advance and alternate send cannot bypass it", async () => {
      const f = await fixture();
      f.duringModel(f.externalWrite);
      try {
        const run = await continueAgentThread(f.context);
        expect((await collect(run)).at(-1)?.type).toBe("turn-error");
        await expect(continueAgentThread(f.context)).rejects.toThrow(RECOVERY);
        await expect(
          queueAgentThreadInput(f.context, "BYPASS", "send")
        ).rejects.toThrow(RECOVERY);
        expect(f.calls()).toBe(2);
      } finally {
        await f.cleanup();
      }
    });

    for (const boundary of [
      "fifo",
      "startup",
      "recovery",
      "refresh",
      "precreate",
    ] as const) {
      for (const cancel of ["signal", "dispose"] as const) {
        it(`${cancel} during ${boundary} rejects promptly and never admits late execution`, async () => {
          const f = await fixture();
          const entered = deferred();
          const release = deferred();
          const abort = new AbortController();
          const reason = new Error("ADMISSION_CANCELLED");
          let restore = () => undefined;
          let createdRunId: string | undefined;
          if (boundary === "fifo") {
            f.context.inputAdmissionQueue = release.promise;
            entered.resolve();
          } else if (boundary === "startup") {
            f.context.lifecycle.to({
              tag: "stopping",
              promise: release.promise,
            });
            entered.resolve();
          } else if (boundary === "recovery") {
            Object.defineProperty(f.context, "durableInputRecovery", {
              value: new DurableInputRecoveryState(),
            });
            const original = f.host.store.inputs.recoverClaims.bind(
              f.host.store.inputs
            );
            f.host.store.inputs.recoverClaims = async (...args) => {
              entered.resolve();
              await release.promise;
              return await original(...args);
            };
            restore = () => {
              f.host.store.inputs.recoverClaims = original;
            };
          } else if (boundary === "refresh") {
            const original = f.host.store.threads.load.bind(
              f.host.store.threads
            );
            f.host.store.threads.load = async (...args) => {
              entered.resolve();
              await release.promise;
              return await original(...args);
            };
            restore = () => {
              f.host.store.threads.load = original;
            };
          } else {
            const original = f.host.store.turns.create.bind(f.host.store.turns);
            f.host.store.turns.create = async (...args) => {
              const result = await original(...args);
              createdRunId = result.record.runId;
              entered.resolve();
              await release.promise;
              return result;
            };
            restore = () => {
              f.host.store.turns.create = original;
            };
          }
          const admission = continueAgentThread(f.context, {
            signal: abort.signal,
          });
          const rejected = expect(admission).rejects.toThrow(
            cancel === "signal" ? "ADMISSION_CANCELLED" : "Thread killed"
          );
          let disposed: Promise<void> | undefined;
          try {
            await entered.promise;
            if (cancel === "signal") {
              abort.abort(reason);
            } else {
              disposed = killAgentThread(f.context);
            }
            // This rejection must not depend on releasing the storage gate.
            await rejected;
            expect(f.calls()).toBe(1);
            expect(f.context.inputQueue).toHaveLength(0);
            release.resolve();
            await f.context.inputAdmissionQueue;
            await disposed;
            if (createdRunId) {
              expect((await f.host.store.turns.get(createdRunId))?.status).toBe(
                "cancelled"
              );
            }
            expect(f.context.inputQueue).toHaveLength(0);
          } finally {
            release.resolve();
            restore();
            await disposed;
            await f.cleanup();
          }
        });
      }
    }

    it("busy and queued durable work never masquerade as an absent task", async () => {
      const f = await fixture();
      const gate = await f.holdDrain();
      try {
        const accepted = await continueAgentThread(f.context);
        await expect(continueAgentThread(f.context)).rejects.toMatchObject({
          code: "THREAD_CONTINUATION_BUSY",
        });
        const done = collect(accepted);
        gate.release();
        await gate.owned;
        await done;
        if (f.context.drain.state.tag === "draining") {
          await f.context.drain.state.promise;
        }
        expect(await continueAgentThread(f.context)).toBeUndefined();
        await f.host.store.inputs.admit({
          threadKey: "thread",
          messageId: "queued",
          kind: "send",
          input: { type: "user-input", text: "QUEUED" },
        });
        await expect(continueAgentThread(f.context)).rejects.toMatchObject({
          code: "THREAD_CONTINUATION_BUSY",
        });
      } finally {
        gate.release();
        await gate.owned;
        await f.cleanup();
      }
    });

    for (const replacement of [
      "lease",
      "cancelled",
      "completed",
      "error",
      "needs-recovery",
    ] as const) {
      it(`B5/B6: ${replacement} before start is observable and never invokes the provider`, async () => {
        const f = await fixture();
        const gate = await f.holdDrain();
        try {
          const run = await continueAgentThread(f.context);
          if (replacement === "lease") {
            expect(
              (
                await f.host.store.turns.claim(runId(run), {
                  attempt: 1,
                  leaseId: "OTHER",
                  leaseMs: 100,
                  nowMs: 10,
                })
              ).ok
            ).toBe(true);
          } else {
            expect(
              (
                await transitionTurn(f.host.store.turns, {
                  runId: runId(run),
                  expected: { status: "queued", leaseId: null },
                  update: { status: replacement },
                })
              ).ok
            ).toBe(true);
          }
          const done = collect(run);
          gate.release();
          await gate.owned;
          const events = await done;
          expect(events.map((event) => event.type)).toEqual(["turn-error"]);
          expect(f.calls()).toBe(1);
          const stored = await f.host.store.turns.get(runId(run));
          expect(stored?.status).toBe(
            replacement === "lease" ? "leased" : replacement
          );
          if (replacement === "lease") {
            expect(stored?.lease?.leaseId).toBe("OTHER");
          }
        } finally {
          gate.release();
          await gate.owned;
          await f.cleanup();
        }
      });
    }

    it("resolves recovery then executes a later notification once and parks its terminal-associated orphan", async () => {
      const f = await fixture();
      const gate = await f.holdDrain();
      let resolved = false;
      let claims = 0;
      const original = f.host.store.inputs.claimNext.bind(f.host.store.inputs);
      f.host.store.inputs.claimNext = async (...args) => {
        const claimed = await original(...args);
        if (claimed) {
          claims += 1;
        }
        if (claims > 8) {
          throw new Error("repeated claim fuse");
        }
        return claimed;
      };
      const notify = () =>
        queueThreadNotification(
          "NOTICE",
          {},
          {
            activeRun: undefined,
            activeRuntimeInput: undefined,
            attachmentStore: undefined,
            drain: () => drainAgentThreadInputQueue(f.context),
            emitObserverEvent: async () => undefined,
            executionHost: f.host,
            inputQueue: f.context.inputQueue,
            pendingRuntimeInputs: f.context.pendingRuntimeInputs,
            threadKey: "thread",
            throwIfTerminal: () => undefined,
          }
        );
      try {
        const blocked = await queueAgentThreadInput(
          f.context,
          "PENDING",
          "send"
        );
        f.context.state.setContinuationCheckpoint([], () => {
          if (!resolved) {
            throw new Error("RECOVERY_REQUIRED");
          }
          return [];
        });
        const done = collect(blocked);
        gate.release();
        await gate.owned;
        expect((await done).at(-1)).toMatchObject({
          type: "turn-error",
          error: { code: "THREAD_RECOVERY_REQUIRED", version: 1 },
        });
        await withThreadDrainOwnership(
          f.host,
          "thread",
          {},
          async () => undefined
        );
        expect((await f.host.store.turns.get(runId(blocked)))?.status).toBe(
          "error"
        );
        expect((await collect(await notify())).at(-1)?.type).toBe("turn-error");
        await withThreadDrainOwnership(
          f.host,
          "thread",
          {},
          async () => undefined
        );
        expect(f.calls()).toBe(1);
        const beforeResolve = claims;
        resolved = true;
        expect((await collect(await notify())).at(-1)?.type).toBe("turn-end");
        await withThreadDrainOwnership(
          f.host,
          "thread",
          {},
          async () => undefined
        );
        expect(f.calls()).toBe(2);
        expect(claims - beforeResolve).toBe(1);
        expect(f.context.inputQueue).toHaveLength(0);
        expect(f.context.drain.state.tag).toBe("idle");
        const pending = await original("thread", "turn-idle");
        expect(pending?.input).toEqual({ type: "user-input", text: "PENDING" });
        assert.ok(pending);
        await f.host.store.inputs.releaseClaim(pending);
      } finally {
        gate.release();
        await gate.owned;
        f.host.store.inputs.claimNext = original;
        await f.cleanup();
      }
    });

    it("closes all queued callers without acknowledging blocked durable inputs", async () => {
      const f = await fixture();
      const gate = await f.holdDrain();
      try {
        const first = await queueAgentThreadInput(f.context, "FIRST", "send");
        const second = await queueAgentThreadInput(
          f.context,
          "SECOND",
          "follow-up"
        );
        const third = await queueAgentThreadInput(f.context, "THIRD", "send");
        f.context.state.setContinuationCheckpoint([], () => {
          throw new Error("RECOVERY_REQUIRED");
        });
        const done = Promise.all([
          collect(first),
          collect(second),
          collect(third),
        ]);
        gate.release();
        await gate.owned;
        for (const events of await done) {
          expect(events.at(-1)?.type).toBe("turn-error");
        }
        await withThreadDrainOwnership(
          f.host,
          "thread",
          {},
          async () => undefined
        );
        expect(f.context.inputQueue).toHaveLength(0);
        expect(f.context.drain.state.tag).toBe("idle");
        expect(f.calls()).toBe(1);
        for (const run of [first, second, third]) {
          expect(["error", "cancelled"]).toContain(
            (await f.host.store.turns.get(runId(run)))?.status
          );
        }
        const pending: import("../../execution/host/types").ClaimedThreadInput[] =
          [];
        for (const text of ["FIRST", "SECOND", "THIRD"]) {
          const claimed = await f.host.store.inputs.claimNext(
            "thread",
            "turn-idle"
          );
          assert.ok(claimed);
          expect(claimed.input).toEqual({ type: "user-input", text });
          pending.push(claimed);
        }
        for (const claimed of pending) {
          await f.host.store.inputs.releaseClaim(claimed);
        }
      } finally {
        gate.release();
        await gate.owned;
        await f.cleanup();
      }
    });

    it("parks a recovery-blocked durable input without re-claiming it", async () => {
      const f = await fixture();
      let claims = 0;
      const original = f.host.store.inputs.claimNext.bind(f.host.store.inputs);
      f.host.store.inputs.claimNext = async (...args) => {
        claims += 1;
        if (claims > 2) {
          throw new Error("claim fuse tripped");
        }
        return await original(...args);
      };
      const gate = await f.holdDrain();
      try {
        const queued = await queueAgentThreadInput(
          f.context,
          "BYPASS",
          "follow-up"
        );
        f.context.state.setContinuationCheckpoint(
          [{ role: "user", content: "ORIGINAL" }],
          () => {
            throw new Error("RECOVERY_REQUIRED");
          }
        );
        const events = collect(queued);
        gate.release();
        await gate.owned;
        expect((await events).at(-1)?.type).toBe("turn-error");
        expect(claims).toBeLessThanOrEqual(2);
        expect(f.calls()).toBe(1);
        const retained = await f.host.store.inputs.claimNext(
          "thread",
          "turn-idle"
        );
        expect(retained?.input).toEqual({ type: "user-input", text: "BYPASS" });
        if (!retained) {
          throw new Error("missing retained input");
        }
        await f.host.store.inputs.releaseClaim(retained);
        // A subsequent drain must stop after the terminal start rejection.
        const drain = f.context.drain.state;
        if (drain.tag === "draining") {
          await drain.promise;
        }
        expect(f.context.drain.state.tag).toBe("idle");
      } finally {
        gate.release();
        await gate.owned;
        await f.cleanup();
      }
    });

    for (const route of ["follow-up", "notify"] as const) {
      it(`execution guard blocks ${route} admitted before recovery sentinel on ${kind}`, async () => {
        const f = await fixture();
        const gate = await f.holdDrain();
        try {
          const queued =
            route === "follow-up"
              ? await queueAgentThreadInput(f.context, "BYPASS", "follow-up")
              : await import("../handle/agent-thread").then(async () => {
                  const { queueThreadNotification } = await import(
                    "./notification"
                  );
                  return await queueThreadNotification(
                    "BYPASS",
                    {},
                    {
                      activeRun: undefined,
                      activeRuntimeInput: undefined,
                      attachmentStore: undefined,
                      drain: () =>
                        import("../handle/agent-thread-drain").then(
                          ({ drainAgentThreadInputQueue }) =>
                            drainAgentThreadInputQueue(f.context)
                        ),
                      emitObserverEvent: async () => undefined,
                      executionHost: f.host,
                      inputQueue: f.context.inputQueue,
                      pendingRuntimeInputs: f.context.pendingRuntimeInputs,
                      threadKey: f.context.threadKey,
                      throwIfTerminal: () => undefined,
                    }
                  );
                });
          f.context.state.setContinuationCheckpoint(
            [{ role: "user", content: "ORIGINAL" }],
            () => {
              throw new Error("RECOVERY_REQUIRED");
            }
          );
          const events = collect(queued);
          gate.release();
          await gate.owned;
          const observed = await events;
          expect(observed.at(-1)).toMatchObject({ type: "turn-error" });
          expect(f.calls()).toBe(1);
          expect(f.context.state.continuationCheckpoint()).toBeDefined();
          expect(f.context.inputQueue).toHaveLength(0);
          if (route === "follow-up") {
            const recovered = await f.host.store.inputs.claimNext(
              "thread",
              "turn-idle"
            );
            expect(recovered).toMatchObject({
              input: { text: "BYPASS" },
              status: "claiming",
            });
            expect(recovered?.messageId).toBeDefined();
            if (!recovered) {
              throw new Error("missing retained follow-up");
            }
            await f.host.store.inputs.releaseClaim(recovered);
            const pending = await f.host.store.inputs.claimNext(
              "thread",
              "turn-idle"
            );
            expect(pending?.input).toEqual({
              type: "user-input",
              text: "BYPASS",
            });
            if (!pending) {
              throw new Error("follow-up was acknowledged");
            }
            await f.host.store.inputs.releaseClaim(pending);
          }
        } finally {
          gate.release();
          await gate.owned;
          await f.cleanup();
        }
      });
    }
  });
}

function runId(turn: AgentTurn | undefined): string {
  assert.ok(turn?.runId);
  return turn.runId;
}
