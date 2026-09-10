import { describe, expect, it } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { createAgentThreadContext } from "../handle/agent-thread-context";
import { continueAgentThread } from "../handle/agent-thread-continuation";
import { killAgentThread } from "../handle/agent-thread-kill";
import { createRuntimeInputState } from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadState } from "../state/thread-state";

describe("stopped ownership", () => {
  it("does not admit Enter during terminal settlement", async () => {
    const host = createInMemoryHost();
    const context = createAgentThreadContext(
      {
        model: createMockLanguageModelV4(() =>
          Promise.resolve(mockLanguageModelV4Text("DONE"))
        ),
      },
      { key: "finishing", store: host.store.threads },
      { executionHost: host }
    );
    await context.state.ensureLoaded();
    context.state.setContinuationCheckpoint([
      { role: "user", content: "ORIGINAL" },
    ]);
    const run = new BufferedAgentTurn();
    const abort = new AbortController();
    context.turn.to({
      tag: "active",
      run,
      abort,
      turnId: "first",
      runtimeInput: createRuntimeInputState([]),
    });
    context.turn.to({ tag: "finishing", run, abort, turnId: "first" });
    await expect(continueAgentThread(context)).rejects.toMatchObject({
      code: "THREAD_CONTINUATION_BUSY",
    });
  });

  it("revokes late checkpoint publication on disposal, even when the old model settles later", async () => {
    const host = createInMemoryHost();
    const context = createAgentThreadContext(
      {
        model: createMockLanguageModelV4(() =>
          Promise.resolve(mockLanguageModelV4Text("DONE"))
        ),
      },
      { key: "outgoing", store: host.store.threads },
      {}
    );
    await context.state.ensureLoaded();
    context.state.setContinuationCheckpoint([
      { role: "user", content: "ORIGINAL" },
    ]);
    await killAgentThread(context);
    context.state.setContinuationCheckpoint([
      { role: "user", content: "LATE" },
    ]);
    expect(context.state.continuationCheckpoint()).toBeUndefined();
  });

  it("preserves user/steering ordering when applying a stopped snapshot", () => {
    const state = new ThreadState({
      key: "order",
      store: createInMemoryHost().store.threads,
    });
    state.setContinuationCheckpoint([
      { role: "user", content: "FIRST" },
      { role: "assistant", content: "PROGRESS" },
      { role: "user", content: "STEER" },
      { role: "assistant", content: "TAIL" },
    ]);
    const checkpoint = state.continuationCheckpoint();
    if (!checkpoint) {
      throw new Error("missing checkpoint");
    }
    expect(state.applyContinuationCheckpoint(checkpoint)).toBe(true);
    expect(state.modelSnapshot()).toEqual(checkpoint.history);
    expect(
      state.modelSnapshot().filter((message) => message.role === "user")
    ).toHaveLength(2);
  });
});
