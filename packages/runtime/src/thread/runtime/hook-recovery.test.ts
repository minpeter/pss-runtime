import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonSchema, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/core/agent";
import type { AgentHooks } from "../../agent/core/hooks";
import { createFileHost } from "../../platform/file";
import { createInMemoryHost } from "../../platform/memory";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
  mockLanguageModelV4ToolCall,
} from "../../testing/mock-language-model-v4-test-utils";
import { collect } from "../handle/test-support";
import { decodeStoredThreadSnapshot } from "../state/snapshot";

const RECOVERY = /recovery/i;

for (const kind of ["memory", "file"] as const) {
  describe(`hook recovery (${kind})`, () => {
    it.each([true, false])(
      "classifies context hook cancellation without swallowing unrelated failure (abort=%s)",
      async (abort) => {
        const directory = await mkdtemp(join(tmpdir(), "hook-cancellation-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const model = vi.fn(() =>
          Promise.resolve(mockLanguageModelV4Text("UNEXPECTED"))
        );
        const thread = new Agent({
          host,
          model: createMockLanguageModelV4(model),
          hooks: {
            transformModelContext: (_event, context) => {
              thread.interrupt();
              if (abort) {
                context.signal.throwIfAborted();
              }
              throw new Error("UNRELATED_HOOK_FAILURE");
            },
          },
        }).thread("context-cancellation");
        try {
          const events = await collect(await thread.send("ORIGINAL"));
          expect(events.at(-1)?.type).toBe(abort ? "turn-abort" : "turn-error");
          expect(model).not.toHaveBeenCalled();
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
    for (const stage of [
      "acceptInput",
      "beforeTurnStart",
      "transformModelContext",
      "transformModelStep",
    ] as const) {
      it(`retries a repaired ${stage} hook without tool effects`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "hook-recovery-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        let failing = true;
        const hooks: AgentHooks = {
          [stage]: () => {
            if (failing) {
              throw new Error("HOOK_FAILURE");
            }
            return { action: "continue" };
          },
        };
        let calls = 0;
        const thread = new Agent({
          host,
          hooks,
          model: createMockLanguageModelV4(() => {
            calls += 1;
            return Promise.resolve(mockLanguageModelV4Text("DONE"));
          }),
        }).thread("thread");
        try {
          if (stage === "acceptInput") {
            await expect(thread.send("FIRST")).rejects.toThrow();
          } else {
            expect(
              (await collect(await thread.send("FIRST"))).at(-1)?.type
            ).toBe("turn-error");
          }
          failing = false;
          expect(
            (await collect(await thread.send("SECOND"))).at(-1)?.type
          ).toBe("turn-end");
          expect(calls).toBe(stage === "transformModelStep" ? 2 : 1);
          const history = decodeStoredThreadSnapshot(
            await host.store.threads.load("thread")
          );
          expect(history.filter((message) => message.role === "user")).toEqual([
            { role: "user", content: "SECOND" },
          ]);
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }

    for (const stage of [
      "tool-output",
      "next-context",
      "next-output",
    ] as const) {
      it(`retains effects and requires recovery when ${stage} hook fails`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "hook-effects-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        let calls = 0;
        let effects = 0;
        let failing = true;
        const thread = new Agent({
          host,
          hooks: {
            transformModelContext: () => {
              if (failing && stage === "next-context" && calls === 1) {
                throw new Error("HOOK_FAILURE");
              }
              return { action: "continue" };
            },
            transformModelStep: () => {
              if (
                failing &&
                ((stage === "tool-output" && calls === 1) ||
                  (stage === "next-output" && calls === 2))
              ) {
                throw new Error("HOOK_FAILURE");
              }
              return { action: "continue" };
            },
          },
          model: createMockLanguageModelV4(() => {
            calls += 1;
            return Promise.resolve(
              calls === 1
                ? mockLanguageModelV4ToolCall({
                    input: {},
                    toolCallId: "effect",
                    toolName: "effect",
                  })
                : mockLanguageModelV4Text("DONE")
            );
          }),
          tools: {
            effect: tool({
              inputSchema: jsonSchema({ type: "object" }),
              execute: () => {
                effects += 1;
                return "COMPLETED_EFFECT";
              },
            }),
          },
        }).thread("thread");
        try {
          expect((await collect(await thread.send("FIRST"))).at(-1)?.type).toBe(
            "turn-error"
          );
          failing = false;
          await expect(thread.send("SECOND")).rejects.toThrow(RECOVERY);
          await expect(thread.followUp("FOLLOWUP")).rejects.toThrow(RECOVERY);
          await expect(thread.continue()).rejects.toThrow(RECOVERY);
          expect(calls).toBe(stage === "next-output" ? 2 : 1);
          expect(effects).toBe(1);
          const history = decodeStoredThreadSnapshot(
            await host.store.threads.load("thread")
          );
          expect(
            history.filter((message) => message.role === "tool")
          ).toHaveLength(1);
          expect(JSON.stringify(history)).toContain("COMPLETED_EFFECT");
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });
}
