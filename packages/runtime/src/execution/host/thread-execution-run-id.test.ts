import { describe, expect, it } from "vitest";
import { createThreadExecutionRunId } from "./thread-execution-run-id";

describe("thread execution run IDs", () => {
  it("preserves scoped thread-key and turn-id boundaries", () => {
    const first = createThreadExecutionRunId({
      threadKey: "scope:tenant:thread:room",
      turnId: "message:1",
    });
    const second = createThreadExecutionRunId({
      threadKey: "scope:tenant:thread:room:message",
      turnId: "1",
    });

    expect(first).toBe("turn:v1:scope%3Atenant%3Athread%3Aroom:message%3A1");
    expect(second).not.toBe(first);
  });
});
