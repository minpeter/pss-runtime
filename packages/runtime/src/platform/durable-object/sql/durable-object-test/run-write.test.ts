import { describe, expect, it } from "vitest";
import type { TurnRecord } from "../../../../execution/host/types";
import { InMemoryDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "../../storage/execution/store";
import { InMemorySqlStorage } from "../node-test/node-sqlite-storage";
import type { SqlStorage } from "../ports/storage-port";
import { InMemoryDurableObjectSqlStorage } from "./storage";

function runRecord(runId: string, status: TurnRecord["status"]): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    status,
    threadKey: "thread-1",
  };
}

describe.each([
  [
    "InMemoryDurableObjectSqlStorage",
    () => new InMemoryDurableObjectSqlStorage(),
  ],
  ["node:sqlite", () => new InMemorySqlStorage()],
] satisfies readonly [string, () => SqlStorage][])(
  "pss_run upserts on %s",
  (_name, createSql) => {
    it("keeps a run's creation position when it is updated", async () => {
      // Given a run followed by a queued follow-up on the same thread
      const store = new DurableObjectExecutionStore({
        prefix: "run-write-test",
        storage: new InMemoryDurableObjectStorage({ sql: createSql() }),
      });
      await store.turns.create(runRecord("a-first", "running"));
      await store.turns.create(runRecord("b-followup", "queued"));

      // When the first run is updated after the follow-up was created
      await store.turns.update(runRecord("a-first", "completed"));

      // Then thread listings still return runs in creation order
      const listed = await store.turns.listByThreadKey?.("thread-1");
      expect(listed?.map((record) => [record.runId, record.status])).toEqual([
        ["a-first", "completed"],
        ["b-followup", "queued"],
      ]);
    });
  }
);
