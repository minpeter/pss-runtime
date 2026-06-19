import { describe, expect, it } from "vitest";
import { createRunCheckpointId } from "./checkpoint-ids";

const checkpointIdPattern =
  /^run-checkpoint:turn%3Aagent%2Fthread%3Aabc:3:before-tool:/;

describe("createRunCheckpointId", () => {
  it("includes the run id, version, and checkpoint phase", () => {
    const checkpointId = createRunCheckpointId({
      phase: "before-tool",
      runId: "turn:agent/thread:abc",
      version: 3,
    });

    expect(checkpointId).toMatch(checkpointIdPattern);
  });
});
