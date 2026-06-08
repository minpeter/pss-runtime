import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import { agentNamespace } from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";

describe("Agent durable resume ownership", () => {
  it("does not let another agent claim a foreign background run", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "background-subagent",
      ownerNamespace: agentNamespace("owner"),
      publicTaskId: "bg_foreign",
      rootRunId: "owner",
      runId: "background:bg_foreign",
      sessionKey:
        "parent:agent:owner:session:default:generation:0:default:subagent:researcher:task:bg_foreign",
      status: "queued",
    });
    const attacker = new Agent({
      host,
      model: () => Promise.resolve([]),
      namespace: "attacker",
    });

    await expect(attacker.resume("background:bg_foreign")).resolves.toBeNull();
    await expect(host.store.runs.get("background:bg_foreign")).resolves.toEqual(
      expect.objectContaining({ status: "queued" })
    );
  });

  it("treats explicit owner namespace as authoritative", async () => {
    const host = createInMemoryExecutionHost();
    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "background-subagent",
      ownerNamespace: agentNamespace("owner"),
      publicTaskId: "bg_poisoned",
      rootRunId: "owner",
      runId: "background:bg_poisoned",
      sessionKey:
        "parent:agent:attacker:session:default:generation:0:default:subagent:researcher:task:bg_poisoned",
      status: "queued",
    });
    const attacker = new Agent({
      host,
      model: () => Promise.resolve([]),
      namespace: "attacker",
    });

    await expect(attacker.resume("background:bg_poisoned")).resolves.toBeNull();
    await expect(
      host.store.runs.get("background:bg_poisoned")
    ).resolves.toEqual(expect.objectContaining({ status: "queued" }));
  });
});
