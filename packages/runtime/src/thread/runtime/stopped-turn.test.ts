import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { deferred } from "../../internal/deferred";
import { createFileHost } from "../../platform/file";
import { createInMemoryHost } from "../../platform/memory";
import {
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { collect } from "../handle/test-support";
import type { AgentEvent } from "../protocol/events";
import { decodeStoredThreadSnapshot } from "../state/snapshot";

type Part =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer P>
    ? P
    : never;
const usage = mockLanguageModelV4Text("").usage;
const RECOVERY = /recovery/i;
const text = (value: string): Part[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: value },
  { type: "text-end", id: "t" },
];
const finish = (reason: "stop" | "length" | "tool-calls"): Part => ({
  type: "finish",
  finishReason: { raw: reason, unified: reason },
  usage,
});
const stream = (parts: Part[]) =>
  Promise.resolve({ stream: convertArrayToReadableStream(parts) });

describe.each(["memory", "file"] as const)(
  "%s stopped foreground recovery",
  (kind) => {
    async function fixture() {
      const directory = await mkdtemp(join(tmpdir(), "stopped-turn-"));
      return {
        host:
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost(),
        cleanup: () => rm(directory, { force: true, recursive: true }),
      };
    }

    it("regenerates the interrupted third request without losing completed turns", async () => {
      const { host, cleanup } = await fixture();
      const requests: MockLanguageModelV4CallOptions[] = [];
      const draft = "THIRD_DRAFT";
      let providerAborts = 0;
      const model = createStreamingMockLanguageModelV4((request) => {
        requests.push(request);
        if (requests.length !== 3) {
          const answer =
            ["DONE FIRST", "DONE SECOND"][requests.length - 1] ?? "DONE NEWEST";
          return stream([...text(answer), finish("stop")]);
        }
        return Promise.resolve({
          stream: new ReadableStream<Part>({
            start(controller) {
              request.abortSignal?.addEventListener(
                "abort",
                () => {
                  providerAborts += 1;
                  controller.error(request.abortSignal?.reason);
                },
                { once: true }
              );
              for (const part of text(draft)) {
                controller.enqueue(part);
              }
            },
          }),
        });
      });
      const thread = new Agent({ host, model }).thread("completed-prefix");
      try {
        expect((await collect(await thread.send("FIRST"))).at(-1)?.type).toBe(
          "turn-end"
        );
        expect((await collect(await thread.send("SECOND"))).at(-1)?.type).toBe(
          "turn-end"
        );
        const interrupted: AgentEvent[] = [];
        // The consumed draft delta gates cancellation; the provider remains open
        // until that exact event, rather than racing a delay against generation.
        for await (const event of (await thread.send("NEWEST")).events()) {
          interrupted.push(event);
          if (event.type === "assistant-output-delta") {
            expect(event.text).toBe(draft);
            thread.interrupt();
          }
        }
        expect(interrupted.at(-1)?.type).toBe("turn-abort");
        expect(providerAborts).toBe(1);
        const continued = await thread.continue();
        if (!continued) {
          throw new Error("missing continuation");
        }
        expect((await collect(continued)).at(-1)?.type).toBe("turn-end");
        expect(requests).toHaveLength(4);
        // Exact provider-boundary array: no role filtering or prefix slicing can
        // hide a missing completed message, retained draft, or injected input.
        expect(requests[3]?.prompt).toEqual([
          { role: "user", content: [{ type: "text", text: "FIRST" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "DONE FIRST" }],
          },
          { role: "user", content: [{ type: "text", text: "SECOND" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "DONE SECOND" }],
          },
          { role: "user", content: [{ type: "text", text: "NEWEST" }] },
        ]);
      } finally {
        await thread.dispose();
        await cleanup();
      }
    });

    it.each(["partial", "length", "length-args"] as const)(
      "continues %s with safe progress and one original user",
      async (stop) => {
        // Given a real provider stream that stops in its first inference.
        const { host, cleanup } = await fixture();
        const requests: MockLanguageModelV4CallOptions[] = [];
        let effects = 0;
        const model = createStreamingMockLanguageModelV4((request) => {
          requests.push(request);
          if (requests.length > 1) {
            return stream([...text("DONE"), finish("stop")]);
          }
          const parts: Part[] = [
            { type: "stream-start", warnings: [] },
            ...text("RETAINED_TEXT"),
            ...(stop === "length-args"
              ? [
                  {
                    type: "tool-input-start" as const,
                    id: "broken",
                    toolName: "effect",
                  },
                  {
                    type: "tool-input-delta" as const,
                    id: "broken",
                    delta: '{"value":',
                  },
                ]
              : []),
          ];
          if (stop !== "partial") {
            return stream([...parts, finish("length")]);
          }
          return Promise.resolve({
            stream: new ReadableStream<Part>({
              start(controller) {
                request.abortSignal?.addEventListener(
                  "abort",
                  () => controller.error(request.abortSignal?.reason),
                  { once: true }
                );
                for (const part of parts) {
                  controller.enqueue(part);
                }
              },
            }),
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
                return "effect";
              },
            }),
          },
        }).thread("task");
        try {
          // When Esc is triggered at the exact delivered delta, or length settles.
          const first = await thread.send("ORIGINAL");
          for await (const event of first.events()) {
            if (stop === "partial" && event.type === "assistant-output-delta") {
              thread.interrupt();
            }
          }
          const continued = await thread.continue();
          expect(continued).toBeDefined();
          if (!continued) {
            return;
          }
          await collect(continued);
          // Then the provider sees safe text, never partial JSON, with fresh cancellation.
          expect(requests).toHaveLength(2);
          expect(requests[1]?.abortSignal).not.toBe(requests[0]?.abortSignal);
          expect(requests[1]?.abortSignal?.aborted).toBe(false);
          expect(requests[1]?.prompt).toHaveLength(1);
          expect(requests[1]?.prompt[0]?.role).toBe("user");
          expect(requests[1]?.prompt[0]?.content).toEqual([
            { type: "text", text: "ORIGINAL" },
          ]);
          expect(JSON.stringify(requests[1]?.prompt)).not.toContain(
            "RETAINED_TEXT"
          );
          expect(JSON.stringify(requests[1]?.prompt)).not.toContain(
            "Continue the interrupted task"
          );
          expect(effects).toBe(0);
          const stored = decodeStoredThreadSnapshot(
            await host.store.threads.load("task")
          );
          expect(stored.filter((message) => message.role === "user")).toEqual([
            { role: "user", content: "ORIGINAL" },
          ]);
          const events: AgentEvent[] = [];
          for await (const event of thread.events()) {
            events.push(event.event);
          }
          expect(
            events.filter((event) => event.type === "user-input")
          ).toHaveLength(1);
          expect(await thread.continue()).toBeUndefined();
        } finally {
          await thread.dispose();
          await cleanup();
        }
      }
    );

    it.each([400, 401, 403])(
      "manually retries a direct HTTP %s without automatic replay",
      async (statusCode) => {
        const { host, cleanup } = await fixture();
        let calls = 0;
        const model = createStreamingMockLanguageModelV4(() => {
          calls += 1;
          if (calls === 1) {
            throw new APICallError({
              message: "rejected",
              requestBodyValues: {},
              url: "https://fixture.invalid",
              statusCode,
            });
          }
          return stream([...text("DONE"), finish("stop")]);
        });
        const thread = new Agent({ host, model }).thread("auth");
        try {
          await collect(await thread.send("ORIGINAL"));
          expect(calls).toBe(1);
          const continued = await thread.continue();
          expect(continued).toBeDefined();
          if (continued) {
            await collect(continued);
          }
          expect(calls).toBe(2);
        } finally {
          await thread.dispose();
          await cleanup();
        }
      }
    );

    it.each(["completed", "ambiguous"] as const)(
      "never replays a %s effect after cancellation",
      async (outcome) => {
        const { host, cleanup } = await fixture();
        let effects = 0;
        const requests: MockLanguageModelV4CallOptions[] = [];
        const model = createStreamingMockLanguageModelV4((request) => {
          requests.push(request);
          return stream(
            requests.length === 1
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "effect-1",
                    toolName: "effect",
                    input: "{}",
                  },
                  finish("tool-calls"),
                ]
              : [...text("DONE"), finish("stop")]
          );
        });
        const thread = new Agent({
          host,
          model,
          tools: {
            effect: tool({
              inputSchema: jsonSchema({ type: "object" }),
              execute: () => {
                effects += 1;
                thread.interrupt();
                if (outcome === "ambiguous") {
                  throw new DOMException(
                    "effect outcome unknown",
                    "AbortError"
                  );
                }
                return "EFFECT_COMMITTED";
              },
            }),
          },
        }).thread("effect");
        try {
          await collect(await thread.send("ORIGINAL"));
          // When explicit Enter follows a real side effect and signal cancellation.
          if (outcome === "ambiguous") {
            await expect(thread.continue()).rejects.toThrow(RECOVERY);
            await expect(thread.continue()).rejects.toThrow(RECOVERY);
            expect(requests).toHaveLength(1);
          } else {
            const continued = await thread.continue();
            expect(continued).toBeDefined();
            if (continued) {
              await collect(continued);
            }
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[1]?.prompt)).toContain(
              "EFFECT_COMMITTED"
            );
            const prompt = requests[1]?.prompt ?? [];
            expect(prompt.some((message) => message.role === "tool")).toBe(
              true
            );
          }
          expect(effects).toBe(1);
        } finally {
          await thread.dispose();
          await cleanup();
        }
      }
    );

    it("reconciles a late successful effect before allowing a model continuation", async () => {
      const { host, cleanup } = await fixture();
      const started = deferred();
      const result = deferred<string>();
      let calls = 0;
      let effects = 0;
      const model = createStreamingMockLanguageModelV4(() => {
        calls += 1;
        return stream(
          calls === 1
            ? [
                {
                  type: "tool-call",
                  toolCallId: "late",
                  toolName: "effect",
                  input: "{}",
                },
                finish("tool-calls"),
              ]
            : [...text("DONE"), finish("stop")]
        );
      });
      const thread = new Agent({
        host,
        model,
        tools: {
          effect: tool({
            inputSchema: jsonSchema({ type: "object" }),
            execute: () => {
              effects += 1;
              started.resolve();
              return result.promise;
            },
          }),
        },
      }).thread("late");
      try {
        const first = collect(await thread.send("ORIGINAL"));
        await started.promise;
        thread.interrupt();
        await expect(thread.continue()).rejects.toMatchObject({
          code: "THREAD_CONTINUATION_BUSY",
        });
        result.resolve("LATE_RESULT");
        await first;
        const continued = await thread.continue();
        expect(continued).toBeDefined();
        if (continued) {
          await collect(continued);
        }
        expect(calls).toBe(2);
        expect(effects).toBe(1);
      } finally {
        result.resolve("LATE_RESULT");
        await thread.dispose();
        await cleanup();
      }
    });
  }
);
