import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import { compaction } from "../plugins";
import { assistantMessage } from "../test-fixtures";
import { applyCompactionOverlays } from "./compaction";

describe("compaction overlays", () => {
  it("applies a range overlay without mutating canonical history", () => {
    const history = messages(["u0", "a1", "u2", "a3", "tail"]);
    const compacted = applyCompactionOverlays(history, [
      {
        createdAt: "2026-06-05T00:00:00.000Z",
        endIndex: 3,
        id: "compact-1",
        startIndex: 0,
        summary: "first four messages",
      },
    ]);

    expect(compacted).toEqual([
      assistantMessage("Compaction summary compact-1: first four messages"),
      { content: "tail", role: "user" },
    ]);
    expect(history).toEqual(messages(["u0", "a1", "u2", "a3", "tail"]));
  });

  it("ignores invalid overlays", () => {
    const history = messages(["u0", "a1"]);

    expect(
      applyCompactionOverlays(history, [
        {
          createdAt: "2026-06-05T00:00:00.000Z",
          endIndex: 9,
          id: "bad",
          startIndex: 0,
          summary: "invalid",
        },
      ])
    ).toEqual(history);
  });

  it("auto compacts model context while preserving canonical history", async () => {
    const seenHistories: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistories.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistories.length}`),
        ]);
      },
      plugins: [
        compaction({
          summarize: ({
            messages: summarizedMessages,
          }: {
            readonly messages: readonly ModelMessage[];
          }) =>
            Promise.resolve(`summarized ${summarizedMessages.length} messages`),
          thresholdMessages: 8,
        }),
      ],
    });
    const session = agent.session("compact");

    for (const input of ["one", "two", "three", "four"]) {
      await drainRun(await session.send(input));
    }
    await drainRun(await session.send("five"));

    expect(seenHistories.at(-1)?.[0]).toEqual(
      assistantMessage("Compaction summary compaction-1: summarized 4 messages")
    );
    expect(seenHistories.at(-1)?.at(-1)).toEqual({
      content: "five",
      role: "user",
    });
  });

  it("extends the existing leading overlay as history grows", async () => {
    const seenHistories: ModelMessage[][] = [];
    const summarizedCounts: number[] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistories.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistories.length}`),
        ]);
      },
      plugins: [
        compaction({
          summarize: ({
            messages: summarizedMessages,
          }: {
            readonly messages: readonly ModelMessage[];
          }) => {
            summarizedCounts.push(summarizedMessages.length);
            return Promise.resolve(
              `summarized ${summarizedMessages.length} messages`
            );
          },
          thresholdMessages: 8,
        }),
      ],
    });
    const session = agent.session("compact-growth");

    for (const input of ["one", "two", "three", "four", "five", "six"]) {
      await drainRun(await session.send(input));
    }
    await drainRun(await session.send("seven"));

    expect(summarizedCounts).toContain(8);
    expect(seenHistories.at(-1)?.[0]).toEqual(
      assistantMessage("Compaction summary compaction-1: summarized 8 messages")
    );
    expect(seenHistories.at(-1)?.at(-1)).toEqual({
      content: "seven",
      role: "user",
    });
  });

  it("uses the configured LLM for default summarization", async () => {
    const seenHistories: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        if (history[0]?.role === "system") {
          return Promise.resolve([assistantMessage("LLM summary")]);
        }
        seenHistories.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [compaction({ thresholdMessages: 8 })],
    });
    const session = agent.session("default-summary");

    for (const input of ["one", "two", "three", "four"]) {
      await drainRun(await session.send(input));
    }
    await drainRun(await session.send("five"));

    expect(seenHistories.at(-1)?.[0]).toEqual(
      assistantMessage("Compaction summary compaction-1: LLM summary")
    );
  });
});

function messages(values: readonly string[]): ModelMessage[] {
  return values.map((value, index) => ({
    content: value,
    role: index % 2 === 0 ? "user" : "assistant",
  }));
}

const drainRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  let eventCount = 0;
  for await (const _event of run.events()) {
    eventCount += 1;
  }
  return eventCount;
};
