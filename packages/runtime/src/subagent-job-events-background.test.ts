import type { ToolSet } from "ai";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi } from "vitest";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  toolExecutionOptions,
  } from "./llm-test-utils";
import {
  backgroundNotificationKey,
  createDurableTestHost,
  resumeBackgroundTask,
  waitForSessionPromptResume,
  } from "./subagent-background-test-support";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
  researcherSubagent,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const backgroundDelegateToolCallId = "call_KeYrzFNLHiz0yjKPQd04vBD5";

describe("background subagent job events", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("orders background subagent launch after parent tool-call while streaming later updates live", async () => {
    const Agent = await loadAgent();
    const childGate = createDeferred();
    const toolCall = toolCallPart(
      "call-background-order",
      "delegate_to_researcher",
      {
        prompt: "research this",
        run_in_background: true,
      }
    );
    const host = createDurableTestHost();
    const researcher = researcherSubagent({
      host,
      model: async () => {
        await childGate.promise;
        return [assistantMessage("CHILD DONE")];
      },
    });
    let launchedTaskId = "";
    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        const launch = (await tools?.delegate_to_researcher?.execute?.(
          {
            prompt: "research this",
            run_in_background: true,
          },
          {
            ...toolExecutionOptions(),
            toolCallId: "call_EQKLyqCmMocIZh6LPbCAb7ts",
          }
        )) as { readonly task_id: string };
        launchedTaskId = launch.task_id;
        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      }
    );
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [researcher],
    });
    const session = agent.session("default");

    const iterator = (await session.send(userText("delegate")))
      .events()
      [Symbol.asyncIterator]();
    const events: string[] = [];
    while (!events.includes("tool-result")) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        events.push(next.value.type);
      }
    }

    expect(events.indexOf("tool-call")).toBeLessThan(
      events.indexOf("subagent-job-start")
    );
    expect(events.indexOf("subagent-job-start")).toBeLessThan(
      events.indexOf("tool-result")
    );

    childGate.resolve();

    while (!events.includes("turn-end")) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      events.push(next.value.type);
    }
    await collectRun(await resumeBackgroundTask(agent, launchedTaskId));

    const notifyEvents = eventTypes(
      await collectRun(
        await waitForSessionPromptResume(
          agent,
          host,
          backgroundNotificationKey(launchedTaskId)
        )
      )
    );
    expect(notifyEvents.indexOf("subagent-job-end")).toBeGreaterThanOrEqual(0);
  });

  it("correlates background subagent lifecycle events to the parent tool call", async () => {
    const Agent = await loadAgent();
    const host = createDurableTestHost();
    const researcher = researcherSubagent({
      host,
      model: async () => [assistantMessage("CHILD DONE")],
    });
    let launchedTaskId = "";
    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        const launch = (await tools?.delegate_to_researcher?.execute?.(
          {
            prompt: "research this",
            run_in_background: true,
          },
          {
            ...toolExecutionOptions(),
            toolCallId: backgroundDelegateToolCallId,
          }
        )) as { readonly task_id: string };
        launchedTaskId = launch.task_id;
        return { responseMessages: [assistantMessage("PARENT DONE")] };
      }
    );
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [researcher],
    });
    const session = agent.session("default");

    const firstEvents = await collectRun(
      await session.send(userText("delegate"))
    );
    const resumeEvents = await collectRun(
      await resumeBackgroundTask(agent, launchedTaskId)
    );
    const notificationEvents = await collectRun(
      await waitForSessionPromptResume(
        agent,
        host,
        backgroundNotificationKey(launchedTaskId)
      )
    );
    const events = [...firstEvents, ...resumeEvents, ...notificationEvents];
    const lifecycleEvents = events.filter(
      (event) =>
        event.type === "subagent-job-start" ||
        event.type === "subagent-job-update" ||
        event.type === "subagent-job-end"
    );

    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delegateToolCallId: backgroundDelegateToolCallId,
          type: "subagent-job-start",
        }),
        expect.objectContaining({
          delegateToolCallId: backgroundDelegateToolCallId,
          type: "subagent-job-end",
        }),
      ])
    );
    expect(JSON.stringify(lifecycleEvents)).not.toContain("parentToolCallId");
    expect(JSON.stringify(lifecycleEvents)).not.toContain(
      "delegate_to_researcher:0"
    );
  });

  it("emits compact background subagent job updates while collecting child events", async () => {
    const Agent = await loadAgent();
    const researcher = researcherSubagent({

      model: async () => [assistantMessage("CHILD DONE")],

    });    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        const launch = (await tools?.delegate_to_researcher?.execute?.(
          {
            prompt: "research this",
            run_in_background: true,
          },
          toolExecutionOptions()
        )) as { task_id: string };
        await tools?.background_output?.execute?.(
          { block: true, task_id: launch.task_id },
          toolExecutionOptions()
        );
        return { responseMessages: [assistantMessage("PARENT DONE")] };
      }
    );
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });
    const events = await collectRun(await agent.send(userText("delegate")));
    const update = events.find(
      (event) =>
        event.type === "subagent-job-update" &&
        event.eventType === "assistant-text"
    );

    expect(update).toEqual(
      expect.objectContaining({
        eventType: "assistant-text",
        status: "running",
        subagent: "researcher",
        type: "subagent-job-update",
      })
    );
    expect(update).not.toHaveProperty("textPreview");
    expect(JSON.stringify(update)).not.toContain("CHILD DONE");
    expect(eventTypes(events)).toContain("subagent-job-update");
  });
});
