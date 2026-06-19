import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../execution";
import type { AgentEvent } from "../../../index";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareThreadPrompt,
  createCloudflareDurableObjectHost,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../../index";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";

const stressThreadCount = 24;
const stressTurnsPerThread = 32;
const stressRunsPerThread = 8;

describe("DurableObjectExecutionStore storage stress", () => {
  it("stores many thread, run, event, checkpoint, notification, and scheduled rows without LLM execution", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({
      prefix: "stress-runtime",
      storage,
    });

    for (
      let threadIndex = 0;
      threadIndex < stressThreadCount;
      threadIndex += 1
    ) {
      const threadKey = `thread-${threadIndex}`;
      let expectedVersion: string | null = null;
      const history: unknown[] = [];

      for (
        let turnIndex = 0;
        turnIndex < stressTurnsPerThread;
        turnIndex += 1
      ) {
        history.push({
          content: `user ${threadIndex}:${turnIndex}`,
          role: "user",
        });
        history.push({
          content: `assistant ${threadIndex}:${turnIndex}`,
          role: "assistant",
        });
        const result = await host.store.threads.commit(
          threadKey,
          { state: { history: [...history], schemaVersion: 1 } },
          { expectedVersion }
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expectedVersion = result.version;
        }
      }

      for (let runIndex = 0; runIndex < stressRunsPerThread; runIndex += 1) {
        const runId = `${threadKey}:run-${runIndex}`;
        const run = runRecord({ runId, threadKey });
        await host.store.runs.create(run);
        await host.store.events.append(runId, eventRecord("step-start"));
        await host.store.events.append(runId, eventRecord("step-end"));
        await host.store.checkpoints.append(
          {
            checkpointId: `${runId}:checkpoint-1`,
            phase: "before-model",
            runId,
            runtimeState: { runIndex },
            threadSnapshot: { threadKey, version: expectedVersion },
            version: 1,
          },
          { expectedVersion: 0 }
        );
        await host.store.runs.update({
          ...run,
          checkpointVersion: 1,
          status: "completed",
        });
        const notificationKey = `${runId}:notify`;
        await host.store.notifications.enqueue({
          idempotencyKey: notificationKey,
          input: { text: `notify ${runId}`, type: "user-text" },
          notificationId: `${runId}:notification`,
          runId,
          status: "pending",
          threadKey,
        });
        await host.store.notifications.claimByIdempotencyKey(notificationKey);
        await host.scheduler.enqueueRun(runId);
        await host.scheduler.resumeThread(threadKey, {
          idempotencyKey: notificationKey,
          runId,
        });
      }
    }

    await expect(
      host.store.threads.load(`thread-${stressThreadCount - 1}`)
    ).resolves.toMatchObject({ version: String(stressTurnsPerThread) });
    await expect(
      host.store.runs.listByParentRunId("missing-parent")
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareRuns(storage, {
        limit: stressThreadCount * stressRunsPerThread,
        prefix: "stress-runtime",
      })
    ).resolves.toHaveLength(stressThreadCount * stressRunsPerThread);
    await expect(
      listScheduledCloudflareThreadPrompts(storage, {
        limit: stressThreadCount * stressRunsPerThread,
        prefix: "stress-runtime",
      })
    ).resolves.toHaveLength(stressThreadCount * stressRunsPerThread);

    for (const runId of await listScheduledCloudflareRuns(storage, {
      prefix: "stress-runtime",
    })) {
      await ackScheduledCloudflareRun(storage, runId, {
        prefix: "stress-runtime",
      });
    }
    for (const prompt of await listScheduledCloudflareThreadPrompts(storage, {
      prefix: "stress-runtime",
    })) {
      await ackScheduledCloudflareThreadPrompt(storage, prompt, {
        prefix: "stress-runtime",
      });
    }
    await expect(
      listScheduledCloudflareRuns(storage, { prefix: "stress-runtime" })
    ).resolves.toEqual([]);
    await expect(
      listScheduledCloudflareThreadPrompts(storage, {
        prefix: "stress-runtime",
      })
    ).resolves.toEqual([]);
  }, 20_000);
});

function runRecord(input: {
  readonly runId: string;
  readonly threadKey: string;
}): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: input.runId,
    runId: input.runId,
    status: "queued",
    threadKey: input.threadKey,
  };
}

function eventRecord(type: "step-start" | "step-end"): AgentEvent {
  if (type === "step-start") {
    return { type: "step-start" };
  }
  return { type: "step-end" };
}
