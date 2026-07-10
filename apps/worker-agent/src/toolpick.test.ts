import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "./session-tools";
import {
  createWorkerAgentPrepareStep,
  isToolpickEnabled,
  WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE,
  WORKER_AGENT_TOOLPICK_RELATED_TOOLS,
} from "./toolpick";
import { SEND_MESSAGE_TOOL_NAME, type WorkerAgentToolSet } from "./tools";

const EmptyInputSchema = z.object({}).strict();

function stubTool(description: string): WorkerAgentToolSet[string] {
  return {
    description,
    execute: async () => ({ ok: true }),
    inputSchema: EmptyInputSchema,
  };
}

const allTools = {
  [LIST_SESSIONS_TOOL_NAME]: stubTool("List recent conversations."),
  [READ_SESSION_TOOL_NAME]: stubTool("Read a conversation transcript."),
  [SEARCH_SESSIONS_TOOL_NAME]: stubTool(
    "Search other conversation transcripts by keywords."
  ),
  [SEND_MESSAGE_TOOL_NAME]: stubTool("Send a user-visible message."),
} satisfies WorkerAgentToolSet;

function prepareStepArgs(content: string) {
  return {
    initialInstructions: undefined,
    initialMessages: [] as ModelMessage[],
    instructions: undefined,
    messages: [{ role: "user" as const, content }],
    model: {} as never,
    responseMessages: [],
    runtimeContext: {},
    stepNumber: 0,
    steps: [],
    toolsContext: {},
  };
}

describe("isToolpickEnabled", () => {
  it("defaults to off", () => {
    expect(isToolpickEnabled({})).toBe(false);
    expect(isToolpickEnabled({ TOOLPICK_ENABLED: "0" })).toBe(false);
    expect(isToolpickEnabled({ TOOLPICK_ENABLED: "false" })).toBe(false);
  });

  it("accepts 1/true/yes", () => {
    expect(isToolpickEnabled({ TOOLPICK_ENABLED: "1" })).toBe(true);
    expect(isToolpickEnabled({ TOOLPICK_ENABLED: "true" })).toBe(true);
    expect(isToolpickEnabled({ TOOLPICK_ENABLED: "YES" })).toBe(true);
  });
});

describe("createWorkerAgentPrepareStep", () => {
  it("always keeps send_message active", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools);
    const result = await prepareStep(
      prepareStepArgs("search past chats about flights")
    );

    expect(result?.activeTools).toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE])
    );
  });

  it("pulls related session tools when one session tool ranks", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools, {
      maxTools: 2,
    });
    const result = await prepareStep(
      prepareStepArgs("search sessions for yesterday dinner plans")
    );
    const active = new Set(result?.activeTools ?? []);

    expect(active.has(SEND_MESSAGE_TOOL_NAME)).toBe(true);
    const sessionSelected = [
      LIST_SESSIONS_TOOL_NAME,
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
    ].filter((name) => active.has(name));
    expect(sessionSelected.length).toBeGreaterThan(0);

    // relatedTools should expand any selected session tool toward the group.
    for (const selected of sessionSelected) {
      for (const related of WORKER_AGENT_TOOLPICK_RELATED_TOOLS[selected] ??
        []) {
        expect(active.has(related)).toBe(true);
      }
    }
  });

  it("emits selection metrics", async () => {
    const onSelect = vi.fn();
    const prepareStep = createWorkerAgentPrepareStep(allTools, { onSelect });

    await prepareStep(prepareStepArgs("just say hi"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: expect.arrayContaining([SEND_MESSAGE_TOOL_NAME]),
        stepNumber: 0,
      })
    );
  });
});
