import { describe, expect, it } from "vitest";
import { describeAgentHostFaultContract } from "../../../contracts/agent-host-fault-contract";
import { describeExecutionStoreContract } from "../../../contracts/execution-store/contract";
import {
  type CelldSqliteTestStorage,
  createCelldSqliteTestStorage,
} from "./celld-sqlite-test-storage";
import { createCelldTestStorage } from "./celld-test-storage";
import { createCelldHost, listCelldScheduledRuns } from "./host";

const CONTRACT_NOW_MS = 1000;
const celldStoreStorages = new WeakMap<object, CelldSqliteTestStorage>();

describeExecutionStoreContract({
  createStore: () => {
    const storage = createCelldSqliteTestStorage();
    const { store } = createCelldHost({
      clock: () => CONTRACT_NOW_MS,
      state: { storage, waitUntil: () => undefined },
    });
    celldStoreStorages.set(store, storage);
    return store;
  },
  name: "Celld",
  transactionalScheduler: {
    expectCommittedRunWake: async (store) => {
      await expect(celldStoreStorages.get(store)?.getAlarm()).resolves.toBe(
        CONTRACT_NOW_MS
      );
    },
    listScheduledRuns: (store) =>
      listCelldScheduledRuns(
        celldStoreStorages.get(store) ?? createCelldSqliteTestStorage(),
        { nowMs: CONTRACT_NOW_MS }
      ),
  },
});

let hostPrefix = 0;

describeAgentHostFaultContract({
  createHost: () => ({
    host: createCelldHost({
      prefix: `celld-host-contract-${hostPrefix++}`,
      state: createState(),
    }),
  }),
  name: "Celld",
});

describe("createCelldHost", () => {
  it("composes Cloudflare storage ports with the Celld scheduler", async () => {
    const state = createState();
    const host = createCelldHost({ state });

    expect(host.store).toBeDefined();
    expect(host.attachmentStore).toBeDefined();
    expect(host.diagnostics).toBeDefined();
    expect(host.scheduler).toBeDefined();

    await host.scheduler.enqueueRun("celld-run");

    await expect(state.storage.getAlarm()).resolves.toBeDefined();
    await host.store.transaction(async (tx) => {
      await tx.scheduler?.enqueueRun("celld-tx-run", { runAfterMs: 10 });
    });
    await expect(
      listCelldScheduledRuns(state.storage, { nowMs: Date.now() + 20 })
    ).resolves.toContain("celld-tx-run");
  });

  it("requires no Cloudflare Agents SDK object or fiber", () => {
    const host = createCelldHost({ state: createState() });

    expect(host.scheduler).toBeDefined();
  });

  it("reconciles persisted scheduled work during activation", async () => {
    const state = createState();
    state.storage.sql.exec(
      "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "pss-runtime",
      "celld-run",
      "orphaned",
      JSON.stringify({ dueAtMs: 42, value: "orphaned" }),
      null,
      "orphaned",
      42,
      42
    );

    createCelldHost({ clock: () => 42, state });
    await Promise.all(state.waits);

    await expect(state.storage.getAlarm()).resolves.toBe(42);
  });
});

function createState() {
  const storage = createCelldTestStorage();
  const waits: Promise<unknown>[] = [];
  return {
    storage,
    waits,
    waitUntil: (promise: Promise<unknown>): void => {
      waits.push(promise);
    },
  };
}
