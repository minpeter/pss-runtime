import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import { assistantMessage, userText } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent session deletion", () => {
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

  it("parent session delete cascades to scoped child sessions", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate first")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "first child work" }, toolExecutionOptions());
    await agent.session("default").delete();
    await drainRun(await agent.send(userText("delegate second")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "second child work" }, toolExecutionOptions());

    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "second child work"
    );
    expect(JSON.stringify(childHistories.at(-1))).not.toContain(
      "first child work"
    );
  });

  it("parent session delete cascades to background task child sessions", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate first")));
    const launch = (await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "background child work", run_in_background: true },
      toolExecutionOptions()
    )) as { sessionKey: string };
    await agent.session("default").delete();
    await drainRun(
      await researcher.session(launch.sessionKey).send(userText("fresh task"))
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("fresh task");
    expect(JSON.stringify(childHistories.at(-1))).not.toContain(
      "background child work"
    );
  });
});
