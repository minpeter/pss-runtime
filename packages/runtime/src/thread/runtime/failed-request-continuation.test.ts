import { APICallError, jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { StoredThreadEvent } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import type { AgentEvent } from "../protocol/events";
import type { AgentTurn } from "../protocol/turn";
import { decodeStoredThreadSnapshot } from "../state/snapshot";

async function collect(turn: AgentTurn | undefined) {
  if (!turn) {
    return [];
  }
  const events: AgentEvent[] = [];
  for await (const event of turn.events()) {
    events.push(event);
  }
  return events;
}

const failure = () =>
  new APICallError({
    message: "provider unavailable",
    requestBodyValues: {},
    responseHeaders: { "retry-after-ms": "0" },
    statusCode: 503,
    url: "https://fixture.invalid",
  });

describe("failed request continuation admission", () => {
  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])(
    "retains completed tools but discards unfinished-step calls (truncated=%s, same step=%s)",
    async (truncated, sameStep, transportError) => {
      const host = createInMemoryHost();
      const requests: MockLanguageModelV4CallOptions[] = [];
      let executions = 0;
      const { usage } = mockLanguageModelV4Text("");
      type Part =
        MockLanguageModelV4StreamResult["stream"] extends ReadableStream<
          infer P
        >
          ? P
          : never;
      const model = createStreamingMockLanguageModelV4((request) => {
        requests.push(structuredClone({ ...request, abortSignal: undefined }));
        const count = requests.length;
        let parts: Part[];
        if (count === 1 && !sameStep) {
          parts = [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "successful",
              toolName: "count",
              input: "{}",
            },
            {
              type: "finish",
              finishReason: { raw: "tool-calls", unified: "tool-calls" },
              usage,
            },
          ];
        } else if (count === (sameStep ? 1 : 2)) {
          parts = [
            { type: "stream-start", warnings: [] },
            ...(sameStep
              ? [
                  {
                    type: "tool-call" as const,
                    toolCallId: "successful",
                    toolName: "count",
                    input: "{}",
                  },
                ]
              : []),
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "Retained progress" },
            { type: "text-end", id: "text" },
            ...(truncated
              ? [
                  {
                    type: "tool-input-start" as const,
                    id: "broken",
                    toolName: "count",
                  },
                  {
                    type: "tool-input-delta" as const,
                    id: "broken",
                    delta: '{"',
                  },
                ]
              : []),
            { type: "error", error: failure() },
          ];
        } else {
          if (request.prompt.at(-1)?.role === "assistant") {
            throw new Error("assistant tail rejected");
          }
          parts = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "done" },
            { type: "text-delta", id: "done", delta: "Finished" },
            { type: "text-end", id: "done" },
            {
              type: "finish",
              finishReason: { raw: "stop", unified: "stop" },
              usage,
            },
          ];
        }
        const stream =
          transportError && count === 2
            ? new ReadableStream<Part>({
                pull(controller) {
                  const part = parts.shift();
                  if (part?.type === "error") {
                    controller.error(part.error);
                  } else if (part) {
                    controller.enqueue(part);
                  } else {
                    controller.close();
                  }
                },
              })
            : convertArrayToReadableStream(parts);
        return Promise.resolve({ stream });
      });
      const thread = new Agent({
        host,
        model,
        tools: {
          count: tool({
            inputSchema: jsonSchema({
              type: "object",
              properties: {},
              additionalProperties: false,
            }),
            execute: () => {
              executions += 1;
              return "successful result";
            },
          }),
        },
      }).thread("safe-progress");
      expect(await thread.continue()).toBeUndefined();
      const failed = await collect(await thread.send("original"));
      expect(failed.at(-1)?.type).toBe("turn-error");
      // Normal failure consumers still see pre-turn rollback.
      expect(
        decodeStoredThreadSnapshot(
          await host.store.threads.load("safe-progress")
        )
      ).toEqual([]);
      const resumed = await thread.continue();
      expect(resumed?.runId).toBeTypeOf("string");
      const completed = await collect(resumed);
      expect(completed.at(-1)?.type).toBe("turn-end");
      expect(executions).toBe(sameStep ? 0 : 1);
      expect(requests).toHaveLength(sameStep ? 2 : 3);
      expect(JSON.stringify(requests.at(-1)?.prompt)).not.toContain(
        "Retained progress"
      );
      expect(
        JSON.stringify(requests.at(-1)?.prompt).includes("successful result")
      ).toBe(!sameStep);
      expect(JSON.stringify(requests.at(-1)?.prompt)).not.toContain("broken");
      const stored = decodeStoredThreadSnapshot(
        await host.store.threads.load("safe-progress")
      );
      expect(stored.filter((message) => message.role === "user")).toHaveLength(
        1
      );
      expect(JSON.stringify(stored)).not.toContain("Retained progress");
      const replay: StoredThreadEvent[] = [];
      for await (const event of thread.events()) {
        replay.push(event);
      }
      expect(
        replay.filter((record) => record.event.type === "user-input")
      ).toHaveLength(1);
      expect(await thread.continue()).toBeUndefined();
      await thread.dispose();
    }
  );

  it("remains continuable after repeated exhausted requests without duplicating unanswered user", async () => {
    const host = createInMemoryHost();
    let calls = 0;
    const requests: MockLanguageModelV4CallOptions[] = [];
    const model = createMockLanguageModelV4((request) => {
      requests.push(request);
      calls += 1;
      if (calls <= 6) {
        throw failure();
      }
      return Promise.resolve(mockLanguageModelV4Text("finished"));
    });
    const thread = new Agent({ host, model }).thread("repeat");
    await collect(await thread.send("original"));
    await collect(await thread.continue());
    expect((await collect(await thread.continue())).at(-1)?.type).toBe(
      "turn-end"
    );
    expect(requests).toHaveLength(7);
    for (const request of requests) {
      expect(
        request.prompt.filter((message) => message.role === "user")
      ).toHaveLength(1);
    }
    expect(
      decodeStoredThreadSnapshot(
        await host.store.threads.load("repeat")
      ).filter((message) => message.role === "user")
    ).toHaveLength(1);
    await thread.dispose();
  });

  it("manually retries an exception from the physical provider boundary", async () => {
    let calls = 0;
    const model = createMockLanguageModelV4(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("provider boundary failed");
      }
      return Promise.resolve(mockLanguageModelV4Text("finished"));
    });
    const thread = new Agent({ model }).thread("runtime-error");
    await collect(await thread.send("original"));
    const continued = await thread.continue();
    expect(continued).toBeDefined();
    await collect(continued);
    expect(calls).toBe(2);
    await thread.dispose();
  });

  it("does not resurrect A after new user B succeeds", async () => {
    let calls = 0;
    const model = createMockLanguageModelV4(() => {
      calls += 1;
      if (calls <= 3) {
        throw failure();
      }
      return Promise.resolve(mockLanguageModelV4Text("B finished"));
    });
    const thread = new Agent({ model }).thread("superseded");
    await collect(await thread.send("A"));
    await collect(await thread.send("B"));
    expect(await thread.continue()).toBeUndefined();
    expect(calls).toBe(4);
    await thread.dispose();
  });

  it("admits only one of two simultaneous continuations", async () => {
    let calls = 0;
    const model = createMockLanguageModelV4(() => {
      calls += 1;
      if (calls <= 3) {
        throw failure();
      }
      return Promise.resolve(mockLanguageModelV4Text("finished"));
    });
    const thread = new Agent({ model }).thread("simultaneous");
    await collect(await thread.send("original"));
    const outcomes = await Promise.allSettled([
      thread.continue(),
      thread.continue(),
    ]);
    const accepted = outcomes.filter(
      (outcome) => outcome.status === "fulfilled"
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected"
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "THREAD_CONTINUATION_BUSY",
    });
    await collect(accepted[0]?.value);
    expect(calls).toBe(4);
    await thread.dispose();
  });
});
