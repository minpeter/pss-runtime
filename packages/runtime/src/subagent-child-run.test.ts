import type { Tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parentSessionNamespace,
  stableAgentNamespace,
} from "./agent-namespace";
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
import {
  assistantMessage,
  createDeferred,
  researcherSubagent,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent child runs", () => {
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

  it("blocking delegation resumes existing child run by dedupe key", async () => {
    const Agent = await loadAgent();
    const childGate = createDeferred();
    const host = createInMemoryExecutionHost();
    let childCalls = 0;
    const agent = new Agent({
      host,
      model: fakeModel,
      namespace: "dedupe-parent",
      subagents: [
        researcherSubagent({
          host,
          model: async () => {
            childCalls += 1;
            await childGate.promise;
            return [assistantMessage("CHILD DONE")];
          },
        }),
      ],
    });
    const parentRunId = testParentRunId("dedupe-parent", "parent");
    await drainRun(await agent.session("parent").send(userText("delegate")));
    const delegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );

    const options = {
      ...toolExecutionOptions(),
      toolCallId: "call_child_dedupe",
    };
    const first = executeDelegate(
      delegate,
      { prompt: "research this" },
      options
    );
    const second = executeDelegate(
      delegate,
      { prompt: "research this" },
      options
    );

    await Promise.resolve();
    childGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        eventCount: expect.any(Number),
        result: "completed",
        run_in_background: false,
        subagent: "researcher",
        text: "CHILD DONE",
      },
      {
        eventCount: expect.any(Number),
        result: "completed",
        run_in_background: false,
        subagent: "researcher",
        text: "CHILD DONE",
      },
    ]);
    expect(childCalls).toBe(1);
    await expect(
      host.store.runs.getByDedupeKey(
        `blocking-subagent:${parentRunId}:call_child_dedupe`
      )
    ).resolves.toMatchObject({
      kind: "subagent",
      parentRunId,
      status: "completed",
    });
  });

  it("blocking delegation scopes durable child runs by agent namespace", async () => {
    const Agent = await loadAgent();
    const host = createInMemoryExecutionHost();
    let childCalls = 0;
    const makeAgent = (namespace: string) => {
      const researcher = researcherSubagent({
        host,
        model: () => {
          childCalls += 1;
          return Promise.resolve([assistantMessage(`CHILD DONE ${namespace}`)]);
        },
      });
      return new Agent({
        host,
        model: fakeModel,
        namespace,
        subagents: [researcher],
      });
    };
    const alpha = makeAgent("alpha");
    const beta = makeAgent("beta");
    const options = {
      ...toolExecutionOptions(),
      toolCallId: "call_child_namespace",
    };

    await drainRun(await alpha.session("parent").send(userText("delegate")));
    const alphaDelegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );
    await drainRun(await beta.session("parent").send(userText("delegate")));
    const betaDelegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );

    await executeDelegate(alphaDelegate, { prompt: "research this" }, options);
    await executeDelegate(betaDelegate, { prompt: "research this" }, options);

    expect(childCalls).toBe(2);
    await expect(
      host.store.runs.listByParentRunId(testParentRunId("alpha", "parent"))
    ).resolves.toHaveLength(1);
    await expect(
      host.store.runs.listByParentRunId(testParentRunId("beta", "parent"))
    ).resolves.toHaveLength(1);
  });
});

async function executeDelegate(
  delegate: Tool,
  input: unknown,
  options: ReturnType<typeof toolExecutionOptions>
): Promise<unknown> {
  const result = delegate.execute?.(input, options);
  if (!result) {
    throw new Error("Expected executable delegate tool.");
  }
  return await result;
}

function testParentRunId(
  namespace: string | undefined,
  sessionKey: string
): string {
  return parentSessionNamespace({
    generation: 0,
    sessionKey,
    sessionNamespace: stableAgentNamespace({ namespace }),
  });
}
