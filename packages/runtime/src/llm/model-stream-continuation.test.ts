import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayAuthenticationError,
  GatewayInternalServerError,
} from "@ai-sdk/gateway";
import { APICallError } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
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

describe.each(["memory", "file"] as const)(
  "%s host non-retryable stream continuation",
  (kind) => {
    it.each([400, 401, 403])(
      "manually admits continuation after a streamed HTTP %s",
      async (statusCode) => {
        const directory = await mkdtemp(
          join(tmpdir(), "pss-stream-rejection-")
        );
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const requests: MockLanguageModelV4CallOptions["prompt"][] = [];
        const model = createStreamingMockLanguageModelV4((request) => {
          requests.push(structuredClone(request.prompt));
          return Promise.resolve({
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              {
                type: "error",
                error: new APICallError({
                  message: "rejected",
                  requestBodyValues: {},
                  statusCode,
                  url: "https://fixture.invalid",
                }),
              },
            ]),
          });
        });
        const thread = new Agent({ host, model }).thread("rejected");
        try {
          const events = await collect(await thread.send("original"));
          expect(events.at(-1)).toMatchObject({
            type: "turn-error",
            error: { status: statusCode, observedRetryable: false },
          });
          expect(
            events.filter((event) => event.type === "model-retry")
          ).toMatchObject([
            {
              attempt: 1,
              phase: "stopped",
              reason: "stream-ended",
              remainingRetries: 0,
            },
          ]);
          const continuation = await thread.continue();
          if (continuation) {
            await collect(continuation);
          }
          expect(continuation).toBeDefined();
          expect(requests).toHaveLength(2);
          expect(
            decodeStoredThreadSnapshot(
              await host.store.threads.load("rejected")
            )
          ).toEqual([]);
          const replay: string[] = [];
          for await (const record of thread.events()) {
            replay.push(record.event.type);
          }
          expect(replay).toEqual([
            "user-input",
            "turn-start",
            "step-start",
            "turn-error",
            "turn-start",
            "step-start",
            "turn-error",
          ]);
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }
);

const apiFailure = (statusCode: number, isRetryable: boolean) =>
  new APICallError({
    message: "provider error",
    requestBodyValues: {},
    statusCode,
    isRetryable,
    url: "https://fixture.invalid",
  });

const streamFailures = [
  { label: "429", error: apiFailure(429, true) },
  { label: "500", error: apiFailure(500, true) },
  { label: "503", error: apiFailure(503, true) },
  {
    label: "503 retry forbidden",
    error: apiFailure(503, false),
  },
  { label: "400 retry allowed", error: apiFailure(400, true) },
  {
    label: "gateway authentication",
    error: new GatewayAuthenticationError(),
  },
  {
    label: "gateway internal",
    error: new GatewayInternalServerError(),
  },
  {
    label: "transport loss",
    error: new Error("connection lost"),
  },
];

describe.each(["memory", "file"] as const)(
  "%s host stream continuation policy",
  (kind) => {
    it.each(streamFailures)(
      "manually continues $label independently of automatic retryability",
      async ({ error }) => {
        const directory = await mkdtemp(join(tmpdir(), "pss-stream-policy-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const requests: MockLanguageModelV4CallOptions["prompt"][] = [];
        const { usage } = mockLanguageModelV4Text("");
        type Part =
          MockLanguageModelV4StreamResult["stream"] extends ReadableStream<
            infer P
          >
            ? P
            : never;
        const model = createStreamingMockLanguageModelV4((request) => {
          requests.push(structuredClone(request.prompt));
          const parts: Part[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text" },
            {
              type: "text-delta",
              id: "text",
              delta: requests.length === 1 ? "PARTIAL" : "DONE",
            },
            { type: "text-end", id: "text" },
            ...(requests.length === 1
              ? [{ type: "error" as const, error }]
              : [
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage,
                  },
                ]),
          ];
          return Promise.resolve({
            stream: new ReadableStream<Part>({
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
            }),
          });
        });
        const thread = new Agent({ host, model }).thread("policy");
        try {
          const failed = await collect(await thread.send("ORIGINAL"));
          expect(failed.at(-1)?.type).toBe("turn-error");
          expect(
            failed.filter((event) => event.type === "model-retry")
          ).toMatchObject([{ phase: "stopped", reason: "stream-ended" }]);
          const continuation = await thread.continue();
          expect(continuation).toBeDefined();
          if (continuation) {
            expect((await collect(continuation)).at(-1)?.type).toBe("turn-end");
          }
          expect(requests).toHaveLength(2);
          const history = decodeStoredThreadSnapshot(
            await host.store.threads.load("policy")
          );
          expect(history).toEqual([
            { role: "user", content: "ORIGINAL" },
            {
              role: "assistant",
              content: [{ type: "text", text: "DONE" }],
            },
          ]);
          expect(requests[1]).toEqual([
            { role: "user", content: [{ type: "text", text: "ORIGINAL" }] },
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
