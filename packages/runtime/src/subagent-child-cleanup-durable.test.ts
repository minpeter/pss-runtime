import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import {
  parentSessionNamespace,
  stableAgentNamespace,
} from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost, RunRecord, RunStore } from "./execution/types";
import { createDeferred } from "./test-fixtures";

describe("durable subagent child cleanup", () => {
  it("reconstructed parent delete cancels linked child runs", async () => {
    const host = createInMemoryExecutionHost();
    const namespace = "cleanup-delete";
    const parentRunId = testParentRunId(namespace);
    await host.store.runs.create(
      createChildRun({
        kind: "subagent",
        parentRunId,
        runId: "child:blocking",
        status: "running",
      })
    );
    await host.store.runs.create(
      createChildRun({
        kind: "background-subagent",
        parentRunId,
        publicTaskId: "bg_1",
        runId: "background:bg_1",
        status: "leased",
      })
    );
    await host.store.runs.create(
      createChildRun({
        kind: "background-subagent",
        parentRunId,
        publicTaskId: "bg_done",
        runId: "background:bg_done",
        status: "completed",
      })
    );
    const reconstructed = new Agent({
      host,
      model: async () => [],
      namespace,
    });

    await reconstructed.session("default").delete();

    await expect(host.store.runs.get("child:blocking")).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(host.store.runs.get("background:bg_1")).resolves.toMatchObject(
      {
        status: "cancelled",
      }
    );
    await expect(
      host.store.runs.get("background:bg_done")
    ).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("kill waits for durable child cancellation before resolving", async () => {
    const { host, releaseList } = createListBlockingHost();
    const namespace = "cleanup-kill";
    await host.store.runs.create(
      createChildRun({
        kind: "background-subagent",
        parentRunId: testParentRunId(namespace),
        publicTaskId: "bg_kill",
        runId: "background:bg_kill",
        status: "running",
      })
    );
    const agent = new Agent({
      host,
      model: async () => [],
      namespace,
    });

    const killPromise = agent.session("default").kill();
    let resolved = false;
    const resolution = killPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseList.resolve();
    await resolution;

    await expect(
      host.store.runs.get("background:bg_kill")
    ).resolves.toMatchObject({
      status: "cancelled",
    });
  });
});

function createListBlockingHost(): {
  readonly host: ExecutionHost;
  readonly releaseList: ReturnType<typeof createDeferred>;
} {
  const base = createInMemoryExecutionHost();
  const releaseList = createDeferred();
  const runs: RunStore = {
    claim: (runId, options) => base.store.runs.claim(runId, options),
    create: (record) => base.store.runs.create(record),
    get: (runId) => base.store.runs.get(runId),
    getByDedupeKey: (dedupeKey) => base.store.runs.getByDedupeKey(dedupeKey),
    listByParentRunId: async (parentRunId) => {
      await releaseList.promise;
      return await base.store.runs.listByParentRunId(parentRunId);
    },
    update: (record) => base.store.runs.update(record),
  };

  return {
    host: {
      ...base,
      store: {
        checkpoints: base.store.checkpoints,
        events: base.store.events,
        notifications: base.store.notifications,
        runs,
        sessions: base.store.sessions,
        transaction: (fn) => base.store.transaction(fn),
      },
    },
    releaseList,
  };
}

function createChildRun(
  input: Pick<RunRecord, "kind" | "runId" | "status"> &
    Pick<Partial<RunRecord>, "parentRunId" | "publicTaskId">
): RunRecord {
  const parentRunId = input.parentRunId ?? testParentRunId("cleanup");
  return {
    checkpointVersion: 0,
    kind: input.kind,
    parentRunId,
    publicTaskId: input.publicTaskId,
    rootRunId: parentRunId,
    runId: input.runId,
    sessionKey: `${input.runId}:session`,
    status: input.status,
  };
}

function testParentRunId(namespace: string): string {
  return parentSessionNamespace({
    generation: 0,
    sessionKey: "default",
    sessionNamespace: stableAgentNamespace({ namespace }),
  });
}
