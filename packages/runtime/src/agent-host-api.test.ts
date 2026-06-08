import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentHost, type AgentOptions } from "./agent";
import type { ExecutionHost } from "./execution/types";
import type { RuntimeLlm } from "./llm";
import { collect, SpyStore } from "./session/session.test-support";
import { assistantMessage, eventTypes } from "./test-fixtures";

const fakeModel = {} as LanguageModel;

const inProcessHost = {} satisfies AgentHost;

const acceptsHostOptions: AgentOptions = {
  host: inProcessHost,
  model: fakeModel,
};
const runtimeModel: RuntimeLlm = () =>
  Promise.resolve([assistantMessage("RUNTIME MODEL")]);
const acceptsRuntimeModelOptions: AgentOptions = {
  model: runtimeModel,
};

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type AssertFalse<T extends false> = T;
type AcceptsHostOption = IsAssignable<typeof acceptsHostOptions, AgentOptions>;
type AcceptsRuntimeModelOption = IsAssignable<
  typeof acceptsRuntimeModelOptions,
  AgentOptions
>;
type RejectsLlmOptionKey = AssertFalse<
  "llm" extends keyof AgentOptions ? true : false
>;
type RejectsRuntimeOptionKey = AssertFalse<
  "runtime" extends keyof AgentOptions ? true : false
>;
type RejectsSessionsOptionKey = AssertFalse<
  "sessions" extends keyof AgentOptions ? true : false
>;
type AcceptsHostSessionStoreKey = IsAssignable<
  { readonly sessionStore: SpyStore },
  AgentHost
>;
type RejectsExecutionHostSessionStoreKey = AssertFalse<
  IsAssignable<{ readonly sessionStore: SpyStore }, ExecutionHost>
>;
type RejectsHostKindKey = AssertFalse<
  "kind" extends keyof AgentHost ? true : false
>;

const typeFixtures = [acceptsHostOptions];
const acceptsHostOptionAssertion: AcceptsHostOption = true;
const acceptsRuntimeModelOptionAssertion: AcceptsRuntimeModelOption = true;
const llmOptionAssertion: RejectsLlmOptionKey = false;
const runtimeOptionAssertion: RejectsRuntimeOptionKey = false;
const sessionsOptionAssertion: RejectsSessionsOptionKey = false;
const hostSessionStoreAssertion: AcceptsHostSessionStoreKey = true;
const executionSessionStoreAssertion: RejectsExecutionHostSessionStoreKey = false;
const hostKindAssertion: RejectsHostKindKey = false;

describe("Agent host public API", () => {
  it("accepts host option and keeps unsupported option keys out of AgentOptions", () => {
    expect(typeFixtures).toHaveLength(1);
    expect(acceptsHostOptionAssertion).toBe(true);
    expect(acceptsRuntimeModelOptionAssertion).toBe(true);
    expect(llmOptionAssertion).toBe(false);
    expect(runtimeOptionAssertion).toBe(false);
    expect(sessionsOptionAssertion).toBe(false);
    expect(hostSessionStoreAssertion).toBe(true);
    expect(executionSessionStoreAssertion).toBe(false);
    expect(hostKindAssertion).toBe(false);
    expect(new Agent({ host: inProcessHost, model: fakeModel })).toBeInstanceOf(
      Agent
    );
  });

  it("accepts custom runtime model functions through model", async () => {
    const seenHistories: unknown[] = [];
    const agent = new Agent({
      model: ({ history }) => {
        seenHistories.push(history);
        return Promise.resolve([assistantMessage("CUSTOM MODEL DONE")]);
      },
    });

    const events = await collect(
      await agent.session("runtime-model").send("hello")
    );

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual({
      text: "CUSTOM MODEL DONE",
      type: "assistant-text",
    });
    expect(JSON.stringify(seenHistories)).toContain("hello");
  });

  it("rejects unsupported llm sessions and runtime options at runtime", () => {
    expect(
      () =>
        new Agent({
          llm: () => Promise.resolve([assistantMessage("DONE")]),
        } as unknown as AgentOptions)
    ).toThrow("Agent: unsupported options.llm");

    expect(
      () =>
        new Agent({
          model: () => Promise.resolve([assistantMessage("DONE")]),
          sessions: { store: new SpyStore() },
        } as unknown as AgentOptions)
    ).toThrow("Agent: unsupported options.sessions");

    expect(
      () =>
        new Agent({
          model: () => Promise.resolve([assistantMessage("DONE")]),
          runtime: {},
        } as unknown as AgentOptions)
    ).toThrow("Agent: unsupported options.runtime");
  });

  it("uses host session store for session snapshots", async () => {
    const sessionStore = new SpyStore();
    const agent = new Agent({
      host: { sessionStore },
      model: () => Promise.resolve([assistantMessage("DONE")]),
    });

    await collect(await agent.session("host-owned").send("hello"));

    expect(sessionStore.commits.at(-1)?.key).toBe("host-owned");
  });
});
