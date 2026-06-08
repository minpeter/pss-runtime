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

describe("subagent background resume", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a notify run only after the background job finishes", async () => {
    const Agent = await loadAgent();
    const childCanFinish = createDeferred();
    let childFinished = false;
    let launchedTaskId = "";
    let parentCalls = 0;
    const researcher = new Agent({
      description: "Researches facts.",
      model: async () => {
        await childCanFinish.promise;
        childFinished = true;
        return [assistantMessage("CHILD DONE")];
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
          const toolCall = toolCallPart(
            "call-delegate",
            "delegate_to_researcher",
            {
              prompt: "research this",
              run_in_background: true,
            }
          );
          const launch = (await tools?.delegate_to_researcher?.execute?.(
            {
              description: "Research facts",
              prompt: "research this",
              run_in_background: true,
            },
            toolExecutionOptions()
          )) as { readonly message: string; readonly task_id: string };
          launchedTaskId = launch.task_id;
          expect(launch.message).toContain("wait for <system-reminder>");
          expect(launch.message).toContain(
            `background_output({ task_id: "${launch.task_id}" })`
          );

          return {
            responseMessages: [
              assistantMessage([toolCall]),
              {
                content: [
                  {
                    output: { type: "json", value: launch },
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    type: "tool-result",
                  },
                ],
                role: "tool",
              },
            ],
          };
        }

        if (!childFinished) {
          return {
            responseMessages: [
              assistantMessage("Background task started; waiting."),
            ],
          };
        }

        expect(childFinished).toBe(true);
        const serializedMessages = JSON.stringify(messages);
        expect(serializedMessages).toContain("<system-reminder>");
        expect(serializedMessages).toContain("[BACKGROUND TASK COMPLETED]");
        expect(serializedMessages).toContain(launchedTaskId);

        return {
          responseMessages: [assistantMessage("NOTIFIED CHILD DONE")],
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

    const firstRun = await session.send(userText("delegate"));
    const firstEvents = await collectAgentRun(firstRun);
    const callsBeforeNotify = parentCalls;
    const firstEventTypes = eventTypes(firstEvents);

    expect(childFinished).toBe(false);
    expect(callsBeforeNotify).toBeGreaterThanOrEqual(1);
    expect(firstEventTypes).toContain("tool-call");
    expect(firstEventTypes).toContain("subagent-job-start");
    expect(firstEventTypes).toContain("tool-result");
    expect(firstEventTypes).toContain("turn-end");
    expect(firstEventTypes).not.toContain("runtime-input");
    expect(firstEventTypes).not.toContain("subagent-job-end");

    childCanFinish.resolve();
    await collectAgentRun(await resumeBackgroundTask(agent, launchedTaskId));
    await expect(
      host.store.notifications.getByIdempotencyKey(
        backgroundNotificationKey(launchedTaskId)
      )
    ).resolves.toMatchObject({ status: "pending" });

    const notifyRun = await waitForSessionPromptResume(
      agent,
      host,
      backgroundNotificationKey(launchedTaskId)
    );
    const notifyEvents = await collectAgentRun(notifyRun);
    expect(parentCalls).toBe(callsBeforeNotify + 1);
    expect(eventTypes(notifyEvents)).toEqual([
      "subagent-job-end",
      "turn-start",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(notifyEvents).toContainEqual(
      expect.objectContaining({
        input: {
          text: expect.stringContaining(
            `Use background_output({ task_id: "${launchedTaskId}" })`
          ),
          type: "user-text",
        },
        placement: "turn-start",
        type: "runtime-input",
      })
    );
  });
});
