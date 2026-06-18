import { describe, expect, it } from "vitest";
import type { RunRecord } from "../execution";
import { storeKey } from "./cloudflare-store-utils";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";
import { InMemorySqlStorage } from "./in-memory-sql-storage";
import {
  createCloudflareDurableObjectHost,
  InMemoryCloudflareDurableObjectStorage,
} from "./index";

const PREFIX = "pss-runtime";
const requiresSqlitePattern = /SQLite-backed/;

const createRun = (runId = "run-1"): RunRecord => ({
  checkpointVersion: 0,
  kind: "user-turn",
  rootRunId: runId,
  runId,
  sessionKey: "session-1",
  status: "queued",
});

describe("createCloudflareDurableObjectHost store selection", () => {
  it("uses SQLite row stores for events/checkpoints on a SQLite-backed Durable Object", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const host = createCloudflareDurableObjectHost({ storage });

    await host.store.runs.create(createRun());

    const big = "x".repeat(120_000);
    // 20 events * ~120KB ~= ~2.4MB — past the Durable Object per-value limit
    // that append-only SQLite rows avoid.
    for (let index = 0; index < 20; index += 1) {
      await host.store.events.append("run-1", {
        output: big,
        toolCallId: "call_1",
        toolName: "web_search",
        type: "tool-result",
      });
    }
    // 20 checkpoints, each embedding a full session snapshot — past 2MB too.
    for (let version = 1; version <= 20; version += 1) {
      await host.store.checkpoints.append(
        {
          checkpointId: `cp-${version}`,
          phase: "after-tool",
          runId: "run-1",
          runtimeState: {},
          sessionSnapshot: { history: [big] },
          version,
        },
        { expectedVersion: version - 1 }
      );
    }

    const events: unknown[] = [];
    for await (const entry of host.store.events.read("run-1")) {
      events.push(entry.event);
    }
    expect(events).toHaveLength(20);

    await expect(host.store.checkpoints.latest("run-1")).resolves.toMatchObject(
      { checkpointId: "cp-20", version: 20 }
    );

    // The SQLite-backed stores do not write per-run list blobs.
    expect(
      await storage.get(storeKey(PREFIX, "events", "run-1"))
    ).toBeUndefined();
    expect(
      await storage.get(storeKey(PREFIX, "checkpoints", "run-1"))
    ).toBeUndefined();
  });

  it("rejects non-SQLite Durable Object storage", () => {
    expect(() =>
      createCloudflareDurableObjectHost({
        storage: {} as CloudflareDurableObjectStorage,
      })
    ).toThrow(requiresSqlitePattern);
  });
});
