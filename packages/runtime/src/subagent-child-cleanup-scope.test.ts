import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import {
  parentSessionNamespace,
  stableAgentNamespace,
} from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { RunRecord } from "./execution/types";

describe("durable subagent child cleanup scope", () => {
  it("does not cancel another agent using the same raw session key", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create(
      createChildRun({
        namespace: "alpha",
        publicTaskId: "bg_alpha",
        runId: "background:bg_alpha",
      })
    );
    await host.store.runs.create(
      createChildRun({
        namespace: "beta",
        publicTaskId: "bg_beta",
        runId: "background:bg_beta",
      })
    );

    await new Agent({
      host,
      model: async () => [],
      namespace: "alpha",
    })
      .session("default")
      .delete();

    await expect(
      host.store.runs.get("background:bg_alpha")
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      host.store.runs.get("background:bg_beta")
    ).resolves.toMatchObject({
      status: "running",
    });
  });
});

function createChildRun({
  namespace,
  publicTaskId,
  runId,
}: {
  readonly namespace: string;
  readonly publicTaskId: string;
  readonly runId: string;
}): RunRecord {
  const parentRunId = parentSessionNamespace({
    generation: 0,
    sessionKey: "default",
    sessionNamespace: stableAgentNamespace({ namespace }),
  });
  return {
    checkpointVersion: 0,
    kind: "background-subagent",
    parentRunId,
    publicTaskId,
    rootRunId: parentRunId,
    runId,
    sessionKey: `${runId}:session`,
    status: "running",
  };
}
