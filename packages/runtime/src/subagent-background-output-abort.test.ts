import { describe, expect, it } from "vitest";
import { createBackgroundOutputTool } from "./subagent-job-output";
import type { SubagentJob } from "./subagent-types";

describe("subagent background output aborts", () => {
  it("stops waiting when the parent tool execution aborts", async () => {
    const jobs = new Map<string, SubagentJob>();
    jobs.set("bg_waiting", {
      abort: () => undefined,
      cleanup: () => Promise.resolve(),
      id: "bg_waiting",
      promise: new Promise(() => undefined),
      sessionKey: "parent:child:task:bg_waiting",
      status: "running",
      subagent: "researcher",
    });
    const abortController = new AbortController();

    const output = createBackgroundOutputTool(jobs).execute?.(
      { block: true, task_id: "bg_waiting", timeout: 1000 },
      {
        abortSignal: abortController.signal,
        context: {},
        messages: [],
        toolCallId: "call-1",
      }
    );
    abortController.abort();

    await expect(
      Promise.race([output, resolvesAfterDelay("still-waiting")])
    ).resolves.toEqual(
      expect.objectContaining({
        status: "running",
        task_id: "bg_waiting",
      })
    );
  });
});

function resolvesAfterDelay(value: string): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), 10);
  });
}
