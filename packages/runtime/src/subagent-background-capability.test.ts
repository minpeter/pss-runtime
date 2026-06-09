import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import {
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
  } from "./llm-test-utils";
import { MemorySessionStore } from "./session/store/memory";
import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
  } from "./session/store/types";
import { assistantMessage,
  userText,
  researcherSubagent,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

class SessionOnlyStore implements SessionStore {
  readonly #store = new MemorySessionStore();

  commit(
    key: string,
    next: SessionStoreCommit,
    options: { readonly expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    return this.#store.commit(key, next, options);
  }

  delete(key: string): Promise<void> {
    return this.#store.delete(key);
  }

  load(key: string): Promise<StoredSession | null> {
    return this.#store.load(key);
  }
}

describe("subagent background capability", () => {
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

  it("hides background tools when the host has no background capability", async () => {
    const Agent = await loadAgent();
    const host = { sessionStore: new SessionOnlyStore() };
    const researcher = researcherSubagent({
      host,
      model: async () => [assistantMessage("CHILD DONE")],
    });
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [researcher],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual(["delegate_to_researcher"]);

    const delegate = executableTool(tools, "delegate_to_researcher");
    await expect(
      delegate.execute?.(
        { prompt: "research this", run_in_background: true },
        toolExecutionOptions()
      )
    ).rejects.toThrow(
      "Background subagent delegation is not available for this host."
    );
  });

  it("hides background tools when a durable host lacks execution storage", async () => {
    const Agent = await loadAgent();
    const host = {
      capabilities: { backgroundSubagents: "durable" as const },
      sessionStore: new SessionOnlyStore(),
    };
    const researcher = researcherSubagent({
      host,
      model: async () => [assistantMessage("CHILD DONE")],
    });
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [researcher],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual(["delegate_to_researcher"]);

    const delegate = executableTool(tools, "delegate_to_researcher");
    await expect(
      delegate.execute?.(
        { prompt: "research this", run_in_background: true },
        toolExecutionOptions()
      )
    ).rejects.toThrow(
      "Background subagent delegation is not available for this host."
    );
  });

  it("hides background tools when a durable host has only session storage and a scheduler", async () => {
    const Agent = await loadAgent();
    const host = {
      backgroundScheduler: {
        enqueueRun: async () => undefined,
        resumeSession: async () => undefined,
      },
      capabilities: { backgroundSubagents: "durable" as const },
      sessionStore: new SessionOnlyStore(),
    };
    const researcher = researcherSubagent({
      host,
      model: async () => [assistantMessage("CHILD DONE")],
    });
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [researcher],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual(["delegate_to_researcher"]);

    const delegate = executableTool(tools, "delegate_to_researcher");
    await expect(
      delegate.execute?.(
        { prompt: "research this", run_in_background: true },
        toolExecutionOptions()
      )
    ).rejects.toThrow(
      "Background subagent delegation is not available for this host."
    );
  });

  it("schedules background work when a durable split-capability host has the required ports", async () => {
    const Agent = await loadAgent();
    const baseHost = createInMemoryExecutionHost();
    const scheduledRunIds: string[] = [];
    const researcher = researcherSubagent({

      host: baseHost,
      model: async () => [assistantMessage("CHILD DONE")],

    });
    const agent = new Agent({
      host: {
        backgroundScheduler: {
          enqueueRun: async (runId, options) => {
            scheduledRunIds.push(runId);
            await baseHost.scheduler.enqueueRun(runId, options);
          },
          resumeSession: (sessionKey, options) =>
            baseHost.scheduler.resumeSession(sessionKey, options),
        },
        capabilities: { backgroundSubagents: "durable" },
        checkpointStore: baseHost.store.checkpoints,
        eventStore: baseHost.store.events,
        notificationInbox: baseHost.store.notifications,
        runStore: baseHost.store.runs,
        sessionStore: baseHost.store.sessions,
        transaction: (fn) => baseHost.store.transaction(fn),
      },
      model: fakeModel,
      subagents: [researcher],
    });

    await drainRun(await agent.send(userText("delegate")));

    const delegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );
    await expect(
      delegate.execute?.(
        { prompt: "research this", run_in_background: true },
        toolExecutionOptions()
      )
    ).resolves.toMatchObject({
      run_in_background: true,
      status: "pending",
    });
    expect(scheduledRunIds).toHaveLength(1);
  });
});
