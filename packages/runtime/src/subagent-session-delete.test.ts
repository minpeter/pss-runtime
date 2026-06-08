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
import { assistantMessage, createDeferred, userText } from "./test-fixtures";

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
      model: ({ history }) => {
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
      model: ({ history }) => {
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
    ).execute?.(
      {
        prompt: "background child work",
        run_in_background: true,
        sessionKey: "background-task",
      },
      toolExecutionOptions()
    );
    await agent.session("default").delete();
    await drainRun(await agent.send(userText("delegate second")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "fresh task", sessionKey: "background-task" },
      toolExecutionOptions()
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("fresh task");
    expect(JSON.stringify(childHistories.at(-1))).not.toContain(
      "background child work"
    );
  });

  it("parent session kill cascades to background task child sessions", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      model: ({ history }) => {
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
    ).execute?.(
      {
        prompt: "background child work",
        run_in_background: true,
        sessionKey: "kill-task",
      },
      toolExecutionOptions()
    );
    await agent.session("default").kill();
    await drainRun(await agent.send(userText("delegate second")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "fresh task", sessionKey: "kill-task" },
      toolExecutionOptions()
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("fresh task");
    expect(JSON.stringify(childHistories.at(-1))).not.toContain(
      "background child work"
    );
  });

  it("does not reuse a killed parent handle when child cleanup fails", async () => {
    const Agent = await loadAgent();
    const childStore = new RejectingDeleteStore();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      model: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      host: { sessionStore: childStore },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });
    const firstSession = agent.session("default");

    await drainRun(await agent.send(userText("delegate first")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "first child work" }, toolExecutionOptions());
    await expect(firstSession.delete()).rejects.toThrow("child cleanup failed");
    const secondSession = agent.session("default");
    await drainRun(await secondSession.send(userText("delegate second")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "second child work" }, toolExecutionOptions());

    expect(secondSession).not.toBe(firstSession);
    expect(JSON.stringify(childHistories.at(-1))).toContain(
      "second child work"
    );
  });

  it("keeps new child cleanup registrations while prior kill cleanup is pending", async () => {
    const Agent = await loadAgent();
    const childStore = new BlockingDeleteStore();
    const researcher = new Agent({
      description: "Researches facts.",
      host: { sessionStore: childStore },
      model: () => Promise.resolve([assistantMessage("CHILD DONE")]),
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate first")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "first child work" }, toolExecutionOptions());
    const killPromise = agent.session("default").kill();
    await childStore.deleteStarted.promise;
    await drainRun(await agent.send(userText("delegate second")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "second child work" }, toolExecutionOptions());
    childStore.allowDelete.resolve();
    await killPromise;
    await agent.session("default").delete();

    expect(childStore.deleteCount).toBe(2);
  });

  it("drops parent handles while child cleanup is pending during delete", async () => {
    const Agent = await loadAgent();
    const childStore = new BlockingDeleteStore();
    const researcher = new Agent({
      description: "Researches facts.",
      host: { sessionStore: childStore },
      model: () => Promise.resolve([assistantMessage("CHILD DONE")]),
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });
    const firstSession = agent.session("default");

    await drainRun(await firstSession.send(userText("delegate first")));
    await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.({ prompt: "first child work" }, toolExecutionOptions());
    const deletion = firstSession.delete();
    await childStore.deleteStarted.promise;
    const secondSession = agent.session("default");
    childStore.allowDelete.resolve();
    await deletion;

    expect(secondSession).not.toBe(firstSession);
  });
});

class RejectingDeleteStore extends SpyStore {
  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("child cleanup failed"));
  }
}

class BlockingDeleteStore extends SpyStore {
  readonly allowDelete = createDeferred();
  deleteCount = 0;
  readonly deleteStarted = createDeferred();

  override async delete(key: string): Promise<void> {
    this.deleteCount += 1;
    this.deleteStarted.resolve();
    await this.allowDelete.promise;
    await super.delete(key);
  }
}
