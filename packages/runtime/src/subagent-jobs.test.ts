import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink, Subagent, SubagentJob } from "./subagent-types";

const parentSessionKey = "parent:default:subagent:researcher";

describe("subagent background jobs", () => {
  it("does not enqueue completion reminders for pruned active jobs", async () => {
    const jobs = new Map<string, SubagentJob>();
    const runtimeInputs: string[] = [];
    let interruptCount = 0;
    const parentSession: RuntimeInputSink = {
      emitObserverEvent: () => undefined,
      enqueueRuntimeInput: (input) => {
        if (input.type === "user-text" && typeof input.text === "string") {
          runtimeInputs.push(input.text);
        }
      },
    };
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => {
          interruptCount += 1;
        },
        send: async () => createDelayedTextRun("STALE RESULT"),
      }),
    };

    const launches = Array.from({ length: 65 }, (_value, index) =>
      startBackgroundJob({
        abortSignal: new AbortController().signal,
        jobs,
        parentSession,
        prompt: { text: `research ${index}`, type: "user-text" },
        sessionKey: `${parentSessionKey}:${index}`,
        subagent,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interruptCount).toBe(1);
    expect(jobs.has(launches[0]?.task_id ?? "")).toBe(false);
    expect(runtimeInputs.join("\n")).not.toContain(launches[0]?.task_id);
  });
});

function createDelayedTextRun(text: string): AgentRun {
  async function* events(): AsyncIterable<AgentEvent> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield { text, type: "assistant-text" };
  }

  return {
    events,
  };
}
