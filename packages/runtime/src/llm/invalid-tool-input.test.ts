import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidToolInputError, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../agent/core/agent";
import { createFileHost } from "../platform/file";
import { createInMemoryHost } from "../platform/memory";
import {
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import { collect } from "../thread/handle/test-support";
import { decodeStoredThreadSnapshot } from "../thread/state/snapshot";
import { generateModelStepResult } from "./model-step";

type Part =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer P>
    ? P
    : never;
const secret = "SOURCE_MUST_NOT_APPEAR_IN_ERROR";
const input = `{"content":"${secret}`;
const inputSchema = z.object({ content: z.string() });
const finish = (reason: "stop" | "length"): Part => ({
  type: "finish",
  finishReason: { raw: reason, unified: reason },
  usage: mockLanguageModelV4Text("").usage,
});
const rejected = (id: string): Part[] => [
  { type: "tool-input-start", id, toolName: "effect" },
  { type: "tool-input-delta", id, delta: input },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName: "effect", input },
];
const done: Part[] = [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "DONE" },
  { type: "text-end", id: "text" },
  finish("stop"),
];

describe.each(["memory", "file"] as const)(
  "%s finalized invalid tool feedback",
  (kind) => {
    it.each(["rejected", "two-rejected", "unfinished", "mixed"] as const)(
      "preserves the %s boundary without replaying effects",
      async (scenario) => {
        const directory = await mkdtemp(join(tmpdir(), "invalid-tools-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const requests: MockLanguageModelV4CallOptions[] = [];
        const execute = vi.fn(() => "EFFECT_COMMITTED");
        const parts: Part[] = [
          ...(scenario === "mixed"
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: "call_completed",
                  toolName: "effect",
                  input: '{"content":"valid"}',
                },
              ]
            : []),
          ...rejected("bad"),
          ...(scenario === "two-rejected" ? rejected("bad-2") : []),
          ...(scenario === "unfinished"
            ? [
                {
                  type: "tool-input-start" as const,
                  id: "unfinished",
                  toolName: "effect",
                },
                {
                  type: "tool-input-delta" as const,
                  id: "unfinished",
                  delta: '{"content":',
                },
              ]
            : []),
          finish("length"),
        ];
        const thread = new Agent({
          host,
          model: createStreamingMockLanguageModelV4((request) => {
            requests.push(request);
            return Promise.resolve({
              stream: convertArrayToReadableStream(
                requests.length === 1 ? parts : done
              ),
            });
          }),
          tools: { effect: tool({ inputSchema, execute }) },
        }).thread("rejection");
        try {
          const events = await collect(await thread.send("ORIGINAL"));
          const stopped = scenario === "unfinished" || scenario === "mixed";
          expect(requests).toHaveLength(stopped ? 1 : 2);
          expect(events.at(-1)?.type).toBe(stopped ? "turn-error" : "turn-end");
          if (stopped) {
            const continued = await thread.continue();
            expect(continued).toBeDefined();
            if (continued) {
              await collect(continued);
            }
          }
          expect(requests).toHaveLength(2);
          expect(execute).toHaveBeenCalledTimes(scenario === "mixed" ? 1 : 0);
          const prompt = requests[1]?.prompt ?? [];
          const feedback = prompt.flatMap((message) =>
            message.role === "tool"
              ? message.content.filter(
                  (part) =>
                    part.type === "tool-result" &&
                    part.toolCallId !== "call_completed"
                )
              : []
          );
          expect(feedback).toHaveLength(scenario === "two-rejected" ? 2 : 1);
          for (const result of feedback) {
            expect(result).toMatchObject({
              output: {
                type: "error-json",
                value: {
                  code: "INVALID_TOOL_ARGUMENTS",
                  kind: "json-parse",
                  finishReason: "length",
                  inputCharacters: input.length,
                },
              },
            });
            expect(JSON.stringify(result).length).toBeLessThan(700);
          }
          expect(JSON.stringify(prompt)).not.toContain(secret);
          expect(JSON.stringify(prompt)).not.toContain("unfinished");
          if (scenario === "mixed") {
            expect(JSON.stringify(prompt)).toContain("EFFECT_COMMITTED");
          }
          const history = decodeStoredThreadSnapshot(
            await host.store.threads.load("rejection")
          );
          expect(history.filter((message) => message.role === "user")).toEqual([
            { role: "user", content: "ORIGINAL" },
          ]);
          expect(await thread.continue()).toBeUndefined();
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }
);

it("does not relabel a genuine branded input callback failure as rejection", async () => {
  const error = new InvalidToolInputError({
    toolName: "effect",
    toolInput: input,
    cause: new Error("CALLBACK_EFFECT"),
  });
  const execute = vi.fn(() => "unexpected");
  const onInputAvailable = vi.fn(() => {
    throw error;
  });
  await expect(
    generateModelStepResult({
      signal: new AbortController().signal,
      history: [{ role: "user", content: "ORIGINAL" }],
      model: createStreamingMockLanguageModelV4(() =>
        Promise.resolve({
          stream: convertArrayToReadableStream([
            ...rejected("bad"),
            finish("length"),
          ]),
        })
      ),
      tools: { effect: tool({ inputSchema, execute, onInputAvailable }) },
    })
  ).rejects.toBe(error);
  expect(onInputAvailable).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});
