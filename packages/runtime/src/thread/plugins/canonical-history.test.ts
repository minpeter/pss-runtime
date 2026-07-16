import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  assistantMessage,
  createCallbackModel,
  createScriptedModelOptions,
  toolCallPart,
  toolResultFor,
  userText,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "../handle/test-support";
import { userTextToModelMessage } from "../protocol/mapping";
import { compactThreadBlocking } from "../runtime/auto-compaction";
import { ThreadState } from "../state/thread-state";
import type { CanonicalHistoryPolicy } from "./canonical-history";

describe("canonical-history plugin capability", () => {
  it("projects loaded state before it becomes canonical", async () => {
    const store = new SpyStore();
    const key = "project-loaded";
    const retained = userTextToModelMessage(userText("retained"));
    store.threads.set(key, {
      state: {
        history: [retained, assistantMessage("remove-on-load")],
        schemaVersion: 1,
      },
      version: "7",
    });
    const policy: CanonicalHistoryPolicy = {
      projectLoadedState: ({ state, threadKey, threadVersion }) => {
        expect(threadKey).toBe(key);
        expect(threadVersion).toBe("7");
        return {
          compactions: state.compactions,
          history: state.history.filter(
            (message) =>
              JSON.stringify(message) !==
              JSON.stringify(assistantMessage("remove-on-load"))
          ),
        };
      },
    };
    const state = new ThreadState({ key, store }, [policy]);

    await state.ensureLoaded();

    expect(state.modelSnapshot()).toEqual([retained]);
    state.appendUserInput(userText("next"));
    await state.commit();
    expect(store.commits[0]?.expectedVersion).toBe("7");
    expect(JSON.stringify(store.threads.get(key)?.state)).not.toContain(
      "remove-on-load"
    );
  });

  it("rejects a model message before append and event emission", async () => {
    const store = new SpyStore();
    const guardError = new Error("model message rejected");
    const agent = new Agent({
      host: hostWithThreads(store),
      model: createCallbackModel(() => [assistantMessage("blocked-output")]),
      plugins: [
        {
          canonicalHistory: {
            beforeAppendModelMessage: ({ message }) => {
              if (JSON.stringify(message).includes("blocked-output")) {
                throw guardError;
              }
            },
          },
          name: "reject-blocked-output",
        },
      ],
    });

    const events = await collect(await agent.thread("append-guard").send("go"));

    expect(events).toContainEqual({
      message: guardError.message,
      type: "turn-error",
    });
    expect(events.some((event) => event.type === "assistant-output")).toBe(
      false
    );
    expect(
      JSON.stringify(store.threads.get("append-guard")?.state)
    ).not.toContain("blocked-output");
  });

  it("rejects a complete model step before any partial event is emitted", async () => {
    const store = new SpyStore();
    const toolCall = toolCallPart("step-call");
    const model = createScriptedModelOptions([
      [
        assistantMessage([
          { text: "would-have-been-visible", type: "text" },
          toolCall,
        ]),
        toolResultFor(toolCall),
      ],
    ]);
    const agent = new Agent({
      ...model,
      host: hostWithThreads(store),
      plugins: [
        {
          canonicalHistory: {
            beforeAppendModelStep: ({ messages }) => {
              if (messages.some((message) => message.role === "tool")) {
                throw new Error("model step rejected");
              }
            },
          },
          name: "reject-model-step",
        },
      ],
    });

    const events = await collect(await agent.thread("step-guard").send("go"));

    expect(events).toContainEqual({
      message: "model step rejected",
      type: "turn-error",
    });
    expect(
      events.some(
        (event) =>
          event.type === "assistant-output" ||
          event.type === "tool-call" ||
          event.type === "tool-result"
      )
    ).toBe(false);
    expect(
      JSON.stringify(store.threads.get("step-guard")?.state)
    ).not.toContain("would-have-been-visible");
  });

  it("rejects a compaction before it mutates state", async () => {
    const store = new SpyStore();
    const policy: CanonicalHistoryPolicy = {
      beforeRecordCompaction: ({ record }) => {
        if (JSON.stringify(record.summary).includes("blocked-summary")) {
          throw new Error("compaction rejected");
        }
      },
    };
    const state = new ThreadState({ key: "compaction-guard", store }, [policy]);
    state.appendUserInput(userText("old"));
    state.history.appendModelMessage(assistantMessage("done"));
    await state.commit();

    await expect(
      state.compact({
        endSeqExclusive: 2,
        startSeq: 0,
        summary: "blocked-summary",
      })
    ).rejects.toThrow("compaction rejected");

    expect(state.compactionSnapshot()).toEqual([]);
    expect(store.commits).toHaveLength(1);
  });

  it("uses the commit hook as the final persistence backstop", async () => {
    const store = new SpyStore();
    const policy: CanonicalHistoryPolicy = {
      beforeCommit: ({ state }) => {
        if (JSON.stringify(state).includes("blocked-at-commit")) {
          throw new Error("commit rejected");
        }
      },
    };
    const state = new ThreadState({ key: "commit-guard", store }, [policy]);
    state.history.appendModelMessage(assistantMessage("blocked-at-commit"));

    await expect(state.commit()).rejects.toThrow("commit rejected");

    expect(store.commits).toEqual([]);
  });

  it("projects model context without rewriting canonical history", () => {
    const store = new SpyStore();
    const policy: CanonicalHistoryPolicy = {
      projectModelContext: ({ messages }) =>
        messages.filter(
          (message) => !JSON.stringify(message).includes("context-only-remove")
        ),
    };
    const state = new ThreadState({ key: "context-projection", store }, [
      policy,
    ]);
    state.appendUserInput(userText("keep-user"));
    state.history.appendModelMessage(assistantMessage("context-only-remove"));
    state.history.appendModelMessage(assistantMessage("keep-assistant"));

    expect(JSON.stringify(state.modelContextSnapshot())).not.toContain(
      "context-only-remove"
    );
    expect(JSON.stringify(state.modelSnapshot())).toContain(
      "context-only-remove"
    );
  });

  it("projects history before auto-compaction summarization", async () => {
    const store = new SpyStore();
    const summarizerInputs: string[] = [];
    const policy: CanonicalHistoryPolicy = {
      projectModelContext: ({ messages }) =>
        messages.filter(
          (message) => !JSON.stringify(message).includes("exclude-from-summary")
        ),
    };
    const state = new ThreadState({ key: "summary-projection", store }, [
      policy,
    ]);
    state.appendUserInput(userText("old-user"));
    state.history.appendModelMessage(assistantMessage("exclude-from-summary"));
    state.appendUserInput(userText("tail-user"));
    state.history.appendModelMessage(assistantMessage("tail-assistant"));
    const model = createCallbackModel(({ history }) => {
      summarizerInputs.push(JSON.stringify(history));
      return [assistantMessage("safe-summary")];
    });

    await expect(
      compactThreadBlocking({
        model: { model },
        policy: { minMessages: 4, retainMessages: 2 },
        state,
      })
    ).resolves.toBe(true);

    expect(summarizerInputs).toHaveLength(1);
    expect(summarizerInputs[0]).not.toContain("exclude-from-summary");
    expect(state.compactionSnapshot()[0]?.summary).toEqual({
      content: "safe-summary",
      role: "system",
    });
  });
});
