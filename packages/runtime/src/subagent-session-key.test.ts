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
import { SpyStore } from "./session/session.test-support";
import { assistantMessage, userText } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent child session keys", () => {
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

  it("keeps child session keys stable across reconstructed parent agents", async () => {
    const Agent = await loadAgent();
    const childStore = new SpyStore();
    const childHistories: unknown[] = [];
    const createResearcher = () =>
      new Agent({
        description: "Researches facts.",
        model: ({ history }) => {
          childHistories.push(history);
          return Promise.resolve([assistantMessage("CHILD DONE")]);
        },
        host: { sessionStore: childStore },
        name: "researcher",
      });
    const createParent = () =>
      new Agent({
        model: fakeModel,
        namespace: "parent",
        subagents: [createResearcher()],
      });

    const firstParent = createParent();
    await drainRun(await firstParent.session("default").send(userText("one")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "first durable child work", sessionKey: "durable-topic" },
      toolExecutionOptions()
    );

    const secondParent = createParent();
    await drainRun(await secondParent.session("default").send(userText("two")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "second durable child work", sessionKey: "durable-topic" },
      toolExecutionOptions()
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "first durable child work"
    );
    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "second durable child work"
    );
  });
});
