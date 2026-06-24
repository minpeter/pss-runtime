import { describe, expect, expectTypeOf, it } from "vitest";
import type { ThreadInspection, ThreadInspectionCompaction } from "../../index";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { assistantMessage } from "../../testing/test-fixtures";
import { SpyStore } from "../../thread/handle/test-support";
import { encodeThreadSnapshot } from "../../thread/state/snapshot";
import { Agent } from "./agent";
import type { ThreadHandle } from "./thread-entry";

const fakeModel = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

describe("thread inspection", () => {
  it("inspects another known thread key without mutating thread state", async () => {
    const threadStore = new SpyStore();
    const summary = assistantMessage("older context summary");
    const summaryBytes = new TextEncoder().encode(
      JSON.stringify(summary)
    ).byteLength;
    threadStore.threads.set("room:42", {
      state: encodeThreadSnapshot(
        [
          { content: "first", role: "user" },
          { content: "second", role: "assistant" },
          { content: "third", role: "user" },
        ],
        [
          {
            endSeqExclusive: 2,
            schemaVersion: 1,
            startSeq: 0,
            summary,
          },
        ]
      ),
      version: "7",
    });
    const agent = new Agent({
      host: { kind: "thread", threadStore },
      model: fakeModel,
    });

    await expect(agent.inspectThread("room:42")).resolves.toEqual({
      compactionCount: 1,
      compactions: [
        {
          endSeqExclusive: 2,
          startSeq: 0,
          summaryBytes,
        },
      ],
      exists: true,
      messageCount: 3,
      summaryBytes,
      threadKey: "room:42",
      version: "7",
    });
    expect(threadStore.commits).toEqual([]);
  });

  it("inspects a thread handle by its canonical scoped key", async () => {
    const threadStore = new SpyStore();
    const agent = new Agent({
      host: { kind: "thread", threadStore },
      model: fakeModel,
    });

    await expect(
      agent.thread({ key: "room/1", scope: "user:1" }).inspect()
    ).resolves.toEqual({
      compactionCount: 0,
      compactions: [],
      exists: false,
      messageCount: 0,
      summaryBytes: 0,
      threadKey: "scope:user%3A1:thread:room%2F1",
      version: null,
    });
  });

  it("exports inspect result types from the package root", () => {
    expectTypeOf<
      Awaited<ReturnType<ThreadHandle["inspect"]>>
    >().toEqualTypeOf<ThreadInspection>();
    expectTypeOf<
      Awaited<ReturnType<Agent["inspectThread"]>>
    >().toEqualTypeOf<ThreadInspection>();
    expectTypeOf<
      ThreadInspection["compactions"][number]
    >().toEqualTypeOf<ThreadInspectionCompaction>();
  });
});
