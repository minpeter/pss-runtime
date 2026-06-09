import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parentSessionNamespace,
  stableAgentNamespace,
} from "./agent-namespace";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost } from "./execution/types";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import { resumeBackgroundTask } from "./subagent-background-test-support";
import {
  assistantMessage,
  eventTypes,
  researcherSubagent,
  toolCallPart,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const sessionKey = "room:edge:user:1";

describe("edge reconstruction host", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconstructs agent and resumes suspended run", async () => {
    const Agent = await loadAgent();
    const host = createDurableHost();
    let taskId = "";
    let parentCalls = 0;

    generateTextMock.mockImplementation(
      async ({ messages, tools }: { messages: unknown; tools?: ToolSet }) => {
        parentCalls += 1;
        if (parentCalls === 1) {
          const toolCall = toolCallPart("call-bg", "delegate_to_researcher", {
            prompt: "research edge resume",
            run_in_background: true,
          });
          const launch = (await tools?.delegate_to_researcher?.execute?.(
            {
              prompt: "research edge resume",
              run_in_background: true,
            },
            toolExecutionOptions()
          )) as { readonly task_id: string };
          taskId = launch.task_id;
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
              assistantMessage("WAITING FOR HOST WAKE"),
            ],
          };
        }

        expect(JSON.stringify(messages)).toContain(
          "[BACKGROUND TASK COMPLETED]"
        );
        expect(JSON.stringify(messages)).toContain(taskId);
        await expect(
          tools?.background_output?.execute?.(
            { task_id: taskId },
            toolExecutionOptions()
          )
        ).resolves.toMatchObject({
          result: {
            result: "completed",
            subagent: "researcher",
            text: "CHILD DONE",
          },
          status: "completed",
          task_id: taskId,
        });
        return {
          responseMessages: [assistantMessage("RESUMED AFTER NOTIFICATION")],
        };
      }
    );

    const firstAgent = createCoordinator(Agent, host);
    const firstEvents = await collectRun(
      await firstAgent.session(sessionKey).send(userText("start background"))
    );
    const callsAfterLaunch = parentCalls;
    expect(eventTypes(firstEvents)).not.toContain("runtime-input");

    const notificationKey = backgroundNotificationKey(taskId);
    const resumeAgent = createCoordinator(Agent, host);
    await collectRun(await resumeBackgroundTask(resumeAgent, taskId));
    const notificationRunId = await waitForNotification(host, notificationKey);
    const reconstructedAgent = createCoordinator(Agent, host);
    const notificationRun = await reconstructedAgent.resume(notificationRunId);
    expect(notificationRun).not.toBeNull();
    if (!notificationRun) {
      throw new Error("Expected notification resume run.");
    }

    const notificationEvents = await collectRun(notificationRun);
    expect(eventTypes(notificationEvents)).toEqual([
      "subagent-job-end",
      "turn-start",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(parentCalls).toBe(callsAfterLaunch + 1);
  });

  it("dedupes duplicate notification delivery", async () => {
    const Agent = await loadAgent();
    const host = createDurableHost();
    const notificationKey = "background-complete:room:edge:user:1:bg_dup";
    await host.store.notifications.enqueue({
      idempotencyKey: notificationKey,
      input: {
        text: "<system-reminder>Task bg_dup is ready</system-reminder>",
        type: "user-text",
      },
      notificationId: "notification-dup",
      observerEvents: [
        {
          eventCount: 1,
          status: "completed",
          subagent: "researcher",
          task_id: "bg_dup",
          type: "subagent-job-end",
        },
      ],
      ownerNamespace: edgeCoordinatorSessionNamespace(),
      runId: "notification-run-dup",
      sessionKey,
      status: "pending",
    });
    await host.store.runs.create({
      checkpointVersion: 0,
      dedupeKey: notificationKey,
      kind: "notification",
      ownerNamespace: edgeCoordinatorSessionNamespace(),
      rootRunId: "notification-run-dup",
      runId: "notification-run-dup",
      sessionKey,
      status: "queued",
    });
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("NOTIFIED ONCE")],
    });
    const agent = createCoordinator(Agent, host);

    const first = await agent.resume("notification-run-dup");
    const second = await agent.resume("notification-run-dup");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    if (first) {
      expect(eventTypes(await collectRun(first))).toContain("runtime-input");
    }
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

function createDurableHost(): ExecutionHost {
  const host = createInMemoryExecutionHost();
  return {
    ...host,
    capabilities: {
      ...host.capabilities,
      backgroundSubagents: "durable",
    },
  };
}

function createCoordinator(
  Agent: typeof import("./agent").Agent,
  host: ExecutionHost
): import("./agent").Agent {
  return new Agent({
    host,
    model: fakeModel,
    namespace: "edge-coordinator",
    subagents: [
      researcherSubagent({
        description: "Researches one sentence.",
        host,
        model: async () => [assistantMessage("CHILD DONE")],
        namespace: "edge-researcher",
      }),
    ],
  });
}

function backgroundNotificationKey(taskId: string): string {
  return `background-complete:${sessionKey}:${taskId}`;
}

function edgeCoordinatorSessionNamespace(): string {
  return parentSessionNamespace({
    generation: 0,
    sessionKey,
    sessionNamespace: stableAgentNamespace({ namespace: "edge-coordinator" }),
  });
}

async function waitForNotification(
  host: ExecutionHost,
  idempotencyKey: string
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const notification =
      await host.store.notifications.getByIdempotencyKey(idempotencyKey);
    if (notification) {
      return notification.runId;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Expected notification ${idempotencyKey}.`);
}
