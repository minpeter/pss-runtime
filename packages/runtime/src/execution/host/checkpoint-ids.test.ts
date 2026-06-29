import { describe, expect, it } from "vitest";
import { createCheckpointId } from "./checkpoint-ids";

const checkpointIdPattern =
  /^checkpoint:turn%3Aagent%2Fthread%3Aabc:3:before-tool:/;

describe("createCheckpointId", () => {
  it("includes the run id, version, and checkpoint phase", () => {
    const checkpointId = createCheckpointId({
      phase: "before-tool",
      runId: "turn:agent/thread:abc",
      version: 3,
    });

    expect(checkpointId).toMatch(checkpointIdPattern);
  });
});
