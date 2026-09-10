import { jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createInMemoryHost } from "../../platform/memory";
import type { MockLanguageModelV4StreamResult } from "../../testing/mock-language-model-v4-test-utils";
import {
  createStreamingMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { AgentThread } from "../handle/agent-thread";
import { collect } from "../handle/test-support";

const RECOVERY = /recovery/i;
type Part =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer P>
    ? P
    : never;

describe("physical tool stopped boundaries", () => {
  it.each(["before-tool", "after-tool"] as const)(
    "keeps %s persistence failure recovery-required even after cancellation",
    async (phase) => {
      const host = createInMemoryHost();
      let effects = 0;
      let calls = 0;
      const model = createStreamingMockLanguageModelV4(() => {
        calls += 1;
        if (calls > 1) {
          throw new Error("UNEXPECTED_REPLAY");
        }
        return Promise.resolve({
          stream: convertArrayToReadableStream([
            {
              type: "tool-call" as const,
              toolCallId: "side-effect",
              toolName: "effect",
              input: "{}",
            },
            {
              type: "finish" as const,
              finishReason: {
                unified: "tool-calls" as const,
                raw: "tool-calls",
              },
              usage: mockLanguageModelV4Text("").usage,
            },
          ]),
        });
      });
      const thread = new Agent({
        host,
        model,
        tools: {
          effect: tool({
            inputSchema: jsonSchema({ type: "object" }),
            execute: () => {
              effects += 1;
              return "EFFECT";
            },
          }),
        },
      }).thread("fenced");
      const capability = host.store.leaseFencedCheckpoints;
      if (!capability) {
        throw new Error("missing fenced checkpoints");
      }
      const append = capability.appendFenced.bind(capability);
      const spy = vi
        .spyOn(capability, "appendFenced")
        .mockImplementation((...args) => {
          if (args[0].phase === phase) {
            thread.interrupt();
            return Promise.reject(new Error("CHECKPOINT_OFFLINE"));
          }
          return append(...args);
        });
      try {
        const events = await collect(await thread.send("ORIGINAL"));
        expect(events.at(-1)?.type).toBe("turn-error");
        await expect(thread.continue()).rejects.toThrow(RECOVERY);
        await expect(thread.continue()).rejects.toThrow(RECOVERY);
        expect(effects).toBe(phase === "before-tool" ? 0 : 1);
        expect(calls).toBe(1);
      } finally {
        spy.mockRestore();
        await thread.dispose();
      }
    }
  );

  it("blocks ambiguous hostless execution instead of regenerating the effect", async () => {
    let effects = 0;
    let calls = 0;
    const model = createStreamingMockLanguageModelV4(() => {
      calls += 1;
      if (calls > 1) {
        throw new Error("UNEXPECTED_REPLAY");
      }
      return Promise.resolve({
        stream: convertArrayToReadableStream([
          {
            type: "tool-call" as const,
            toolCallId: "hostless",
            toolName: "effect",
            input: "{}",
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage: mockLanguageModelV4Text("").usage,
          },
        ]),
      });
    });
    const thread = new AgentThread(
      {
        model,
        tools: {
          effect: tool({
            inputSchema: jsonSchema({ type: "object" }),
            execute: (): string => {
              effects += 1;
              thread.interrupt();
              throw new DOMException("uncertain", "AbortError");
            },
          }),
        },
      },
      { key: "hostless", store: createInMemoryHost().store.threads }
    );
    try {
      await collect(await thread.send("ORIGINAL"));
      await expect(thread.continue()).rejects.toThrow(RECOVERY);
      expect(effects).toBe(1);
      expect(calls).toBe(1);
    } finally {
      await thread.dispose();
    }
  });

  it("treats a delivered tool-error result as progress, not a stopped successful answer", async () => {
    let calls = 0;
    let effects = 0;
    const model = createStreamingMockLanguageModelV4(() => {
      calls += 1;
      return Promise.resolve({
        stream: convertArrayToReadableStream<Part>(
          calls === 1
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: "failed",
                  toolName: "effect",
                  input: "{}",
                },
                {
                  type: "finish" as const,
                  finishReason: {
                    unified: "tool-calls" as const,
                    raw: "tool-calls",
                  },
                  usage: mockLanguageModelV4Text("").usage,
                },
              ]
            : [
                { type: "text-start" as const, id: "t" },
                { type: "text-delta" as const, id: "t", delta: "DONE" },
                { type: "text-end" as const, id: "t" },
                {
                  type: "finish" as const,
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: mockLanguageModelV4Text("").usage,
                },
              ]
        ),
      });
    });
    const thread = new Agent({
      model,
      tools: {
        effect: tool({
          inputSchema: jsonSchema({ type: "object" }),
          execute: (): string => {
            effects += 1;
            throw new Error("EXPECTED_TOOL_ERROR");
          },
        }),
      },
    }).thread("tool-error");
    try {
      expect((await collect(await thread.send("ORIGINAL"))).at(-1)?.type).toBe(
        "turn-end"
      );
      expect(await thread.continue()).toBeUndefined();
      expect(effects).toBe(1);
      expect(calls).toBe(2);
    } finally {
      await thread.dispose();
    }
  });
});
