import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "./session-tools";
import {
  countOuterToolMisses,
  createWorkerAgentPrepareStep,
  hasStickySessionTools,
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
  [LIST_SESSIONS_TOOL_NAME]: stubTool(
    "List other recent conversations past chats previous sessions."
  ),
  [READ_SESSION_TOOL_NAME]: stubTool(
    "Read a conversation transcript from a prior session."
  ),
  [SEARCH_SESSIONS_TOOL_NAME]: stubTool(
    "Search other conversation transcripts by keywords past chats recall."
  ),
  [SEND_MESSAGE_TOOL_NAME]: stubTool("Send a user-visible message."),
} satisfies WorkerAgentToolSet;

function prepareStepArgs(messages: ModelMessage[]) {
  return {
    initialInstructions: undefined,
    initialMessages: [] as ModelMessage[],
    instructions: undefined,
    messages,
    model: {} as never,
    responseMessages: [],
    runtimeContext: {},
    stepNumber: 0,
    steps: [],
    toolsContext: {},
  };
}

describe("countOuterToolMisses / sticky session", () => {
  it("counts text-only assistant steps after the last user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "assistant", content: "still here" },
    ];
    expect(countOuterToolMisses(messages)).toBe(2);
  });

  it("resets misses after a tool-call assistant step", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "find last chat" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: SEARCH_SESSIONS_TOOL_NAME,
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: SEARCH_SESSIONS_TOOL_NAME,
            output: { type: "json", value: {} },
          },
        ],
      },
    ];
    expect(countOuterToolMisses(messages)).toBe(0);
    expect(hasStickySessionTools(messages)).toBe(true);
  });
});

describe("createWorkerAgentPrepareStep", () => {
  it("keeps pure chat on send_message-only", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools);
    const result = await prepareStep(
      prepareStepArgs([{ role: "user", content: "just say hi" }])
    );

    expect(result?.activeTools).toEqual([SEND_MESSAGE_TOOL_NAME]);
  });

  it("always keeps send_message active on recall queries", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools);
    const result = await prepareStep(
      prepareStepArgs([
        { role: "user", content: "search past chats about flights" },
      ])
    );

    expect(result?.activeTools).toEqual(
      expect.arrayContaining([...WORKER_AGENT_TOOLPICK_ALWAYS_ACTIVE])
    );
  });

  it("pulls related session tools when one session tool ranks", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools);
    const result = await prepareStep(
      prepareStepArgs([
        {
          role: "user",
          content: "search sessions for yesterday dinner plans recall",
        },
      ])
    );
    const active = new Set(result?.activeTools ?? []);

    expect(active.has(SEND_MESSAGE_TOOL_NAME)).toBe(true);
    const sessionSelected = [
      LIST_SESSIONS_TOOL_NAME,
      SEARCH_SESSIONS_TOOL_NAME,
      READ_SESSION_TOOL_NAME,
    ].filter((name) => active.has(name));
    expect(sessionSelected.length).toBeGreaterThan(0);

    for (const selected of sessionSelected) {
      for (const related of WORKER_AGENT_TOOLPICK_RELATED_TOOLS[selected] ??
        []) {
        expect(active.has(related)).toBe(true);
      }
    }
  });

  it("keeps session tools sticky after a session tool call in the open turn", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools);
    const result = await prepareStep(
      prepareStepArgs([
        { role: "user", content: "what did we talk about last week?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "1",
              toolName: SEARCH_SESSIONS_TOOL_NAME,
              input: { query: "last week" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: SEARCH_SESSIONS_TOOL_NAME,
              output: { type: "json", value: { sessions: [] } },
            },
          ],
        },
      ])
    );

    expect(result?.activeTools).toEqual(
      expect.arrayContaining([
        SEND_MESSAGE_TOOL_NAME,
        LIST_SESSIONS_TOOL_NAME,
        SEARCH_SESSIONS_TOOL_NAME,
        READ_SESSION_TOOL_NAME,
      ])
    );
  });

  it("falls back to all tools after two outer-step misses", async () => {
    const prepareStep = createWorkerAgentPrepareStep(allTools);
    const result = await prepareStep(
      prepareStepArgs([
        { role: "user", content: "find that prior conversation" },
        { role: "assistant", content: "thinking" },
        { role: "assistant", content: "still thinking" },
      ])
    );

    expect(new Set(result?.activeTools)).toEqual(
      new Set(Object.keys(allTools))
    );
  });

  it("emits selection metrics with reason", async () => {
    const onSelect = vi.fn();
    const prepareStep = createWorkerAgentPrepareStep(allTools, { onSelect });

    await prepareStep(
      prepareStepArgs([{ role: "user", content: "just say hi" }])
    );

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTools: [SEND_MESSAGE_TOOL_NAME],
        reason: "hybrid",
        stepNumber: 0,
      })
    );
  });
});
