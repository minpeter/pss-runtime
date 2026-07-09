import { describe, expect, it, onTestFinished } from "vitest";
import type { HostScheduler } from "../../execution";
import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";

export interface ExecutionSchedulerContractListOptions {
  readonly limit?: number;
  readonly nowMs?: number;
}

export interface ExecutionSchedulerContractHarness {
  ackRun(runId: string): Promise<void>;
  ackThreadPrompt(prompt: ScheduledThreadPrompt): Promise<void>;
  /**
   * Current platform timer target in epoch ms, for platforms that surface
   * delayed work through a timer instead of due-time-filtered lists.
   */
  alarmTimeMs?(): number | undefined;
  cleanup?(): void | Promise<void>;
  listRuns(
    options?: ExecutionSchedulerContractListOptions
  ): Promise<readonly string[]>;
  listThreadPrompts(
    options?: ExecutionSchedulerContractListOptions
  ): Promise<readonly ScheduledThreadPrompt[]>;
  readonly scheduler: HostScheduler;
}

export interface ExecutionSchedulerContractOptions {
  readonly createHarness: () =>
    | ExecutionSchedulerContractHarness
    | Promise<ExecutionSchedulerContractHarness>;
  readonly name: string;
  /**
   * Whether list results filter by due time. The memory and file adapters
   * store a dueAt per work item; the cloudflare adapter delegates dueness to
   * the Durable Object alarm and lists every pending item.
   */
  readonly supportsDueTimeFiltering: boolean;
}

export function describeExecutionSchedulerContract({
  createHarness,
  name,
  supportsDueTimeFiltering,
}: ExecutionSchedulerContractOptions): void {
  const setup = async (): Promise<ExecutionSchedulerContractHarness> => {
    const harness = await createHarness();
    onTestFinished(async () => {
      await harness.cleanup?.();
    });
    return harness;
  };

  describe(`${name} HostScheduler contract`, () => {
    it("lists enqueued runs until they are acked", async () => {
      const harness = await setup();
      await harness.scheduler.enqueueRun("run-1");
      await harness.scheduler.enqueueRun("run-2");
      // Same-millisecond tie order is platform-defined (cloudflare: insertion
      // order; memory/file: work-id order), so assert membership, not order.
      expect([...(await harness.listRuns())].sort()).toEqual([
        "run-1",
        "run-2",
      ]);

      await harness.ackRun("run-1");
      expect(await harness.listRuns()).toEqual(["run-2"]);
    });

    it("dedupes runs enqueued with the same run id", async () => {
      const harness = await setup();
      await harness.scheduler.enqueueRun("run-1");
      await harness.scheduler.enqueueRun("run-1");
      expect(await harness.listRuns()).toEqual(["run-1"]);
    });

    it("applies list limits to scheduled runs", async () => {
      const harness = await setup();
      await harness.scheduler.enqueueRun("run-1");
      await harness.scheduler.enqueueRun("run-2");
      await harness.scheduler.enqueueRun("run-3");
      expect(await harness.listRuns({ limit: 2 })).toHaveLength(2);
      expect(await harness.listRuns({ limit: 0 })).toHaveLength(0);
    });

    it("records thread prompts with their resume options", async () => {
      const harness = await setup();
      await harness.scheduler.resumeThread("thread-1", {
        idempotencyKey: "idem-1",
        notificationId: "notification-1",
        runId: "run-1",
      });
      expect(await harness.listThreadPrompts()).toEqual([
        {
          idempotencyKey: "idem-1",
          notificationId: "notification-1",
          runId: "run-1",
          threadKey: "thread-1",
        },
      ]);
    });

    it("dedupes thread prompts sharing thread key, idempotency key, and run id", async () => {
      const harness = await setup();
      await harness.scheduler.resumeThread("thread-1", {
        idempotencyKey: "idem-1",
        runId: "run-1",
      });
      await harness.scheduler.resumeThread("thread-1", {
        idempotencyKey: "idem-1",
        runId: "run-1",
      });
      expect(await harness.listThreadPrompts()).toHaveLength(1);
    });

    it("keeps thread prompts with distinct idempotency keys separate", async () => {
      const harness = await setup();
      await harness.scheduler.resumeThread("thread-1", {
        idempotencyKey: "idem-1",
        runId: "run-1",
      });
      await harness.scheduler.resumeThread("thread-1", {
        idempotencyKey: "idem-2",
        runId: "run-1",
      });
      expect(await harness.listThreadPrompts()).toHaveLength(2);
    });

    it("acks thread prompts individually", async () => {
      const harness = await setup();
      await harness.scheduler.resumeThread("thread-1", {
        idempotencyKey: "idem-1",
        runId: "run-1",
      });
      await harness.scheduler.resumeThread("thread-2", {
        idempotencyKey: "idem-2",
        runId: "run-2",
      });
      const [first] = await harness.listThreadPrompts();
      await harness.ackThreadPrompt(first);
      expect(await harness.listThreadPrompts()).toHaveLength(1);
    });

    it.runIf(supportsDueTimeFiltering)(
      "defers delayed runs until they are due",
      async () => {
        const harness = await setup();
        const beforeEnqueueMs = Date.now();
        await harness.scheduler.enqueueRun("run-later", {
          runAfterMs: 60_000,
        });
        expect(await harness.listRuns({ nowMs: beforeEnqueueMs })).toEqual([]);
        expect(await harness.listRuns({ nowMs: Date.now() + 120_000 })).toEqual(
          ["run-later"]
        );
      }
    );

    it.runIf(!supportsDueTimeFiltering)(
      "arms the platform timer for delayed runs",
      async () => {
        const harness = await setup();
        const beforeEnqueueMs = Date.now();
        await harness.scheduler.enqueueRun("run-later", {
          runAfterMs: 60_000,
        });
        const alarmTimeMs = harness.alarmTimeMs?.();
        expect(alarmTimeMs).toBeDefined();
        expect(alarmTimeMs).toBeGreaterThanOrEqual(beforeEnqueueMs + 60_000);
      }
    );
  });
}
