import type { Agent, AgentInput, AgentTurn } from "@minpeter/pss-runtime";
import {
  createInMemoryExecutionHost,
  type ExecutionHost,
  type ResumeThreadOptions,
} from "@minpeter/pss-runtime/execution";
import {
  defaultChildThreadKey,
  parentThreadNamespace,
} from "@minpeter/pss-runtime/namespace";
import { describe, expect, it } from "vitest";
import { createAppAgent } from "./app-agent";
import { launchDurableBackgroundDelegation } from "./background-delegation";
import { createBackgroundOutputTool } from "./background-output-tool";
import { readerChildName } from "./delegate-tool";

const parentThreadKey = "default";
const ownerNamespace = parentThreadNamespace("coordinator", parentThreadKey);

describe("app-owned background delegation", () => {
  it("does not resume a background task owned by another app namespace", async () => {
    const host = createInMemoryExecutionHost();
    const job = await launchTask(host, {
      ownerNamespace: "app:other:default",
    });
    const appAgent = createTestAppAgent(host);

    await expect(appAgent.resume(`background:${job.id}`)).rejects.toThrow(
      "is not owned by this app"
    );
  });

  it("does not return stored output for another app namespace", async () => {
    const host = createInMemoryExecutionHost();
    const job = await launchTask(host, {
      ownerNamespace: "app:other:default",
    });
    const run = await host.store.turns.get(`background:${job.id}`);
    if (!run) {
      throw new Error("expected background run to exist");
    }
    await host.store.turns.update({
      ...run,
      output: { text: "SECRET" },
      status: "completed",
    });
    const backgroundOutput = createBackgroundOutputTool({
      executionHost: host,
      ownerNamespace,
      parentThreadKey,
    });

    await expect(
      backgroundOutput.execute?.(
        { task_id: job.id },
        {
          abortSignal: undefined,
          context: {},
          messages: [],
          toolCallId: "call-output",
        }
      )
    ).rejects.toThrow("접근할 수 없다");
  });

  it("does not create a duplicate notification run after duplicate enqueue", async () => {
    const { host, resumeCalls } = createCountingHost();
    const job = await launchTask(host);
    const idempotencyKey = `background-complete:${parentThreadKey}:${job.id}`;
    await host.store.notifications.enqueue({
      idempotencyKey,
      input: { text: "already queued", type: "user-input" },
      notificationId: `notification:${job.id}`,
      ownerNamespace,
      runId: `notification:${job.id}`,
      threadKey: parentThreadKey,
      status: "pending",
    });
    const appAgent = createTestAppAgent(host);

    await appAgent.resume(`background:${job.id}`);

    await expect(
      host.store.turns.get(`notification:${job.id}`)
    ).resolves.toBeNull();
    expect(resumeCalls).toEqual([]);
  });

  it("resumes an owned completion notification without runtime-owned namespace helpers", async () => {
    const host = createInMemoryExecutionHost();
    const job = await launchTask(host);
    const appAgent = createTestAppAgent(host);
    await appAgent.resume(`background:${job.id}`);

    const notificationRun = await appAgent.resume(`notification:${job.id}`);

    expect(notificationRun).not.toBeNull();
    if (!notificationRun) {
      throw new Error("expected completion notification to resume");
    }
    await expect(collectAssistantOutput(notificationRun)).resolves.toBe(
      "coordinator saw notification"
    );
    await expect(
      host.store.turns.get(`notification:${job.id}`)
    ).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });
});

async function launchTask(
  host: ExecutionHost,
  overrides: { readonly ownerNamespace?: string } = {}
) {
  return await launchDurableBackgroundDelegation({
    executionHost: host,
    ownerNamespace: overrides.ownerNamespace ?? ownerNamespace,
    parentThreadKey,
    prompt: "read product docs",
    threadKey: defaultChildThreadKey(
      overrides.ownerNamespace ?? ownerNamespace,
      parentThreadKey,
      readerChildName
    ),
    subagent: readerChildName,
  });
}

function createTestAppAgent(host: ExecutionHost): Agent {
  return createAppAgent({
    coordinator: {
      resume: () => Promise.resolve(null),
      thread: () => ({
        send: async (_input: AgentInput) =>
          runWithText("coordinator saw notification"),
      }),
    } as unknown as Agent,
    host,
    ownerNamespace,
    parentThreadKey,
    reader: createReaderAgent(),
  });
}

async function collectAssistantOutput(run: AgentTurn) {
  let text = "";
  for await (const event of run.events()) {
    if (event.type === "assistant-output") {
      text += event.text;
    }
  }
  return text;
}

function createReaderAgent(): Agent {
  return {
    thread: () =>
      ({
        send: async (_input: AgentInput) => runWithText("reader result"),
      }) as Agent["thread"] extends (key: string) => infer Thread
        ? Thread
        : never,
  } as unknown as Agent;
}

function runWithText(text: string): AgentTurn {
  return {
    events: () => eventStream([{ text, type: "assistant-output" }]),
  };
}

async function* eventStream(
  events: readonly {
    readonly text: string;
    readonly type: "assistant-output";
  }[]
) {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

function createCountingHost() {
  const baseHost = createInMemoryExecutionHost();
  const resumeCalls: { options: ResumeThreadOptions; threadKey: string }[] = [];
  const host: ExecutionHost = {
    ...baseHost,
    scheduler: {
      enqueueRun: async (runId, options) => {
        await baseHost.scheduler.enqueueRun(runId, options);
      },
      resumeThread: async (threadKey, options) => {
        resumeCalls.push({ options, threadKey });
        await baseHost.scheduler.resumeThread(threadKey, options);
      },
    },
  };
  return { host, resumeCalls };
}
