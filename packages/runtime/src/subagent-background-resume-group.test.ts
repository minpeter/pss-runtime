import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import {
  backgroundNotificationKey,
  collectAgentRun,
  createDurableTestHost,
  resumeBackgroundTask,
  settlesWithin,
  waitForSessionPromptResume,
} from "./subagent-background-test-support";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  toolCallPart,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent background group resume", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for every same-turn background job before sending the success notification", async () => {
    const Agent = await loadAgent();
    const firstCanFinish = createDeferred();
    const secondCanFinish = createDeferred();
    const firstFinished = createDeferred();
    let launchedTaskIds: readonly string[] = [];
    let parentCalls = 0;
    const researcher = new Agent({
      description: "Researches facts.",
      model: async ({ history }) => {
        const serializedHistory = JSON.stringify(history);
        if (serializedHistory.includes("research first")) {
          await firstCanFinish.promise;
          firstFinished.resolve();
          return [assistantMessage("FIRST CHILD DONE")];
        }

        await secondCanFinish.promise;
        return [assistantMessage("SECOND CHILD DONE")];
      },
      name: "researcher",
    });

    generateTextMock.mockImplementation(
      async ({
        messages,
        tools,
      }: {
        readonly messages: unknown;
        readonly tools?: ToolSet;
      }) => {
        parentCalls += 1;
        if (parentCalls === 1) {
          const firstToolCall = toolCallPart(
            "call-delegate-first",
            "delegate_to_researcher",
            {
              prompt: "research first",
              run_in_background: true,
            }
          );
          const secondToolCall = toolCallPart(
            "call-delegate-second",
            "delegate_to_researcher",
            {
              prompt: "research second",
              run_in_background: true,
            }
          );
          const firstLaunch = (await tools?.delegate_to_researcher?.execute?.(
            {
              prompt: "research first",
              run_in_background: true,
            },
            toolExecutionOptions()
          )) as { readonly task_id: string };
          const secondLaunch = (await tools?.delegate_to_researcher?.execute?.(
            {
              prompt: "research second",
              run_in_background: true,
            },
            toolExecutionOptions()
          )) as { readonly task_id: string };
          launchedTaskIds = [firstLaunch.task_id, secondLaunch.task_id];

          return {
            responseMessages: [
              assistantMessage([firstToolCall, secondToolCall]),
              {
                content: [
                  {
                    output: { type: "json", value: firstLaunch },
                    toolCallId: firstToolCall.toolCallId,
                    toolName: firstToolCall.toolName,
                    type: "tool-result",
                  },
                  {
                    output: { type: "json", value: secondLaunch },
                    toolCallId: secondToolCall.toolCallId,
                    toolName: secondToolCall.toolName,
                    type: "tool-result",
                  },
                ],
                role: "tool",
              },
            ],
          };
        }

        const serializedMessages = JSON.stringify(messages);
        if (!serializedMessages.includes("[ALL BACKGROUND TASKS COMPLETE]")) {
          return {
            responseMessages: [
              assistantMessage("Background tasks started; waiting."),
            ],
          };
        }

        for (const taskId of launchedTaskIds) {
          expect(serializedMessages).toContain(taskId);
        }

        return {
          responseMessages: [assistantMessage("ALL NOTIFIED")],
        };
      }
    );
    const host = createDurableTestHost();
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [researcher],
    });
    const session = agent.session("default");

    await collectAgentRun(await session.send(userText("delegate")));
    const firstTaskId = launchedTaskIds[0];
    const secondTaskId = launchedTaskIds[1];
    if (!(firstTaskId && secondTaskId)) {
      throw new Error("Expected both background tasks to launch.");
    }

    firstCanFinish.resolve();
    await collectAgentRun(await resumeBackgroundTask(agent, firstTaskId));
    await firstFinished.promise;
    const pendingNotifyRun = waitForSessionPromptResume(
      agent,
      host,
      backgroundNotificationKey(...launchedTaskIds)
    );
    await expect(settlesWithin(pendingNotifyRun, 20)).resolves.toBe(false);

    secondCanFinish.resolve();
    await collectAgentRun(await resumeBackgroundTask(agent, secondTaskId));
    const notifyEvents = await collectAgentRun(await pendingNotifyRun);
    const runtimeInput = notifyEvents.find(
      (event) => event.type === "runtime-input"
    );
    const reminderText =
      runtimeInput?.type === "runtime-input" &&
      runtimeInput.input.type === "user-text"
        ? runtimeInput.input.text
        : "";

    expect(eventTypes(notifyEvents)).toContain("runtime-input");
    expect(reminderText).toEqual(
      expect.stringContaining("[ALL BACKGROUND TASKS COMPLETE]")
    );
    for (const taskId of launchedTaskIds) {
      expect(reminderText).toEqual(expect.stringContaining(taskId));
    }
  });
});
