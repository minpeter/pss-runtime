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
      settled: false,
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

  it("keeps cancelled jobs until the child run settles", async () => {
    const jobs = new Map<string, SubagentJob>();
    let cleanupCount = 0;
    jobs.set("bg_cancelled", {
      abort: () => undefined,
      cleanup: () => {
        cleanupCount += 1;
        return Promise.resolve();
      },
      id: "bg_cancelled",
      promise: new Promise(() => undefined),
      sessionKey: "parent:child:task:bg_cancelled",
      settled: false,
      status: "cancelled",
      subagent: "researcher",
    });

    const output = await createBackgroundOutputTool(jobs).execute?.(
      { task_id: "bg_cancelled" },
      {
        abortSignal: new AbortController().signal,
        context: {},
        messages: [],
        toolCallId: "call-1",
      }
    );

    expect(output).toEqual(
      expect.objectContaining({
        status: "cancelled",
        task_id: "bg_cancelled",
      })
    );
    expect(cleanupCount).toBe(0);
    expect(jobs.has("bg_cancelled")).toBe(true);
  });
});

function resolvesAfterDelay(value: string): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), 10);
  });
}
