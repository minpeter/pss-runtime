import { describe, expect, it } from "vitest";
import type { AgentHost } from "../../execution";
import { createInMemoryHost } from "../../platform/memory";
import { MemoryAttachmentStore } from "../../platform/memory/storage/memory-attachment-store";
import { hostWithThreads } from "../../testing/host-with-threads";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
} from "../../testing/test-fixtures";
import { collect, SpyStore } from "../../thread/handle/test-support";
import type {
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
  HostAttachmentStore,
} from "../../thread/input/attachments";
import { Agent, type AgentOptions } from "./agent";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

const inProcessHost = createInMemoryHost() satisfies AgentHost;

const acceptsHostOptions: AgentOptions = {
  host: inProcessHost,
  model: fakeModel,
};
const runtimeModel = () => Promise.resolve([assistantMessage("RUNTIME MODEL")]);
const functionModelOptions = {
  model: runtimeModel,
} as const;

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type AssertFalse<T extends false> = T;
type AcceptsHostOption = IsAssignable<typeof acceptsHostOptions, AgentOptions>;
type AcceptsRuntimeModelOption = IsAssignable<
  typeof functionModelOptions,
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
type RejectsBareThreadStoreAsHost = AssertFalse<
  IsAssignable<{ readonly threadStore: SpyStore }, AgentHost>
>;
type RejectsKindKeyOnHost = AssertFalse<
  "kind" extends keyof AgentHost ? true : false
>;
type AcceptsInMemoryHostAsAgentHost = IsAssignable<
  typeof inProcessHost,
  AgentHost
>;

const acceptsHostOptionAssertion: AcceptsHostOption = true;
const rejectsRuntimeModelOptionAssertion: AssertFalse<AcceptsRuntimeModelOption> =
  false;
const llmOptionAssertion: RejectsLlmOptionKey = false;
const runtimeOptionAssertion: RejectsRuntimeOptionKey = false;
const sessionsOptionAssertion: RejectsSessionsOptionKey = false;
const hostThreadStoreAssertion: RejectsBareThreadStoreAsHost = false;
const hostKindAssertion: RejectsKindKeyOnHost = false;
const acceptsInMemoryHostAssertion: AcceptsInMemoryHostAsAgentHost = true;

describe("Agent host public API", () => {
  it("accepts host option and keeps unsupported option keys out of AgentOptions", () => {
    expect(acceptsHostOptionAssertion).toBe(true);
    expect(rejectsRuntimeModelOptionAssertion).toBe(false);
    expect(llmOptionAssertion).toBe(false);
    expect(runtimeOptionAssertion).toBe(false);
    expect(sessionsOptionAssertion).toBe(false);
    expect(hostThreadStoreAssertion).toBe(false);
    expect(hostKindAssertion).toBe(false);
    expect(acceptsInMemoryHostAssertion).toBe(true);
    expect(new Agent({ host: inProcessHost, model: fakeModel })).toBeInstanceOf(
      Agent
    );
  });

  it("rejects custom runtime model functions through model", () => {
    expect(() => Reflect.construct(Agent, [functionModelOptions])).toThrow(
      "Agent: invalid options.model"
    );
  });

  it("does not implement legacy llm sessions and runtime options", () => {
    expect(() =>
      Reflect.construct(Agent, [
        {
          llm: () => Promise.resolve([assistantMessage("DONE")]),
        },
      ])
    ).toThrow("Agent: missing options.model");

    expect(() =>
      Reflect.construct(Agent, [
        {
          model: runtimeModel,
          sessions: { store: new SpyStore() },
        },
      ])
    ).toThrow("Agent: invalid options.model");

    expect(() =>
      Reflect.construct(Agent, [
        {
          model: runtimeModel,
          runtime: {},
        },
      ])
    ).toThrow("Agent: invalid options.model");
  });

  it("uses host thread store for thread snapshots", async () => {
    const threadStore = new SpyStore();
    const agent = new Agent({
      host: hostWithThreads(threadStore),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.thread("host-owned").send("hello"));

    expect(threadStore.commits.at(-1)?.key).toBe("host-owned");
  });

  it("includes scoped thread addresses in the stored thread key", async () => {
    const threadStore = new SpyStore();
    const agent = new Agent({
      host: hostWithThreads(threadStore),
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(
      await agent.thread({ key: "room/1", scope: "user:1" }).send("hello")
    );

    expect(threadStore.commits.at(-1)?.key).toBe(
      "scope:user%3A1:thread:room%2F1"
    );
  });

  it("uses a caller-provided host attachment store before an option store", async () => {
    const baseHost = createInMemoryHost();
    const hostAttachmentStore = new TrackingAttachmentStore();
    const optionAttachmentStore = new TrackingAttachmentStore();
    const agent = new Agent({
      attachmentStore: optionAttachmentStore,
      host: { ...baseHost, attachmentStore: hostAttachmentStore },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(
      await agent.send([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          type: "file",
        },
      ])
    );

    expect(hostAttachmentStore.putCount).toBe(1);
    expect(optionAttachmentStore.putCount).toBe(0);
  });

  it("uses an option attachment store when Agent creates the host", async () => {
    const attachmentStore = new TrackingAttachmentStore();
    const agent = new Agent({
      attachmentStore,
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(
      await agent.send([
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          type: "file",
        },
      ])
    );

    expect(attachmentStore.putCount).toBe(1);
  });

  it("always reports resume support for the single host contract", () => {
    const agent = new Agent({ host: inProcessHost, model: fakeModel });
    expect(agent.supportsResume).toBe(true);
  });
});

class TrackingAttachmentStore implements HostAttachmentStore {
  readonly #store = new MemoryAttachmentStore();
  #putCount = 0;

  get putCount(): number {
    return this.#putCount;
  }

  delete(ref: RuntimeAttachmentReference): Promise<void> {
    return this.#store.delete(ref);
  }

  get(ref: RuntimeAttachmentReference): Promise<RuntimeAttachmentBlob | null> {
    return this.#store.get(ref);
  }

  async put(
    input: RuntimeAttachmentPutInput
  ): Promise<RuntimeAttachmentReference> {
    this.#putCount += 1;
    return await this.#store.put(input);
  }
}
