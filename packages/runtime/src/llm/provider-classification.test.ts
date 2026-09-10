import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent/core/agent";
import { createFileHost } from "../platform/file";
import { createInMemoryHost } from "../platform/memory";
import {
  createMockLanguageModelV4,
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  type MockLanguageModelV4GenerateResult,
  type MockLanguageModelV4StreamResult,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import { collect } from "../thread/handle/test-support";
import { decodeStoredThreadSnapshot } from "../thread/state/snapshot";
import {
  failedRequestMessages,
  PrimitiveProviderError,
  ProviderReportedError,
} from "./failed-request";
import { generateModelStepResult } from "./model-step";

type Part =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer P>
    ? P
    : never;
type Reason = MockLanguageModelV4GenerateResult["finishReason"]["unified"];
type Failure = { reason: Reason; text: string } | { thrown: unknown };

function fixture(
  mode: "direct" | "stream" | "stream-throw" | "stream-read",
  failure: Failure
) {
  const requests: MockLanguageModelV4CallOptions["prompt"][] = [];
  const model =
    mode === "direct"
      ? createMockLanguageModelV4((request) => {
          requests.push(structuredClone(request.prompt));
          if (requests.length !== 1) {
            return Promise.resolve(mockLanguageModelV4Text("DONE"));
          }
          if ("thrown" in failure) {
            throw failure.thrown;
          }
          return Promise.resolve({
            ...mockLanguageModelV4Text(failure.text),
            content: failure.text
              ? [{ type: "text" as const, text: failure.text }]
              : [],
            finishReason: { unified: failure.reason, raw: "fixture-raw" },
          });
        })
      : createStreamingMockLanguageModelV4((request) => {
          requests.push(structuredClone(request.prompt));
          if (
            requests.length === 1 &&
            "thrown" in failure &&
            mode === "stream-throw"
          ) {
            throw failure.thrown;
          }
          const first = requests.length === 1;
          const draft = "text" in failure ? failure.text : "DRAFT";
          const text = first ? draft : "DONE";
          const parts: Part[] = [
            { type: "stream-start", warnings: [] },
            ...(text
              ? [
                  { type: "text-start" as const, id: "text" },
                  { type: "text-delta" as const, id: "text", delta: text },
                  { type: "text-end" as const, id: "text" },
                ]
              : []),
            ...(first && "thrown" in failure
              ? [{ type: "error" as const, error: failure.thrown }]
              : [
                  {
                    type: "finish" as const,
                    finishReason: {
                      unified:
                        first && "reason" in failure
                          ? failure.reason
                          : ("stop" as const),
                      raw: "fixture-raw",
                    },
                    usage: mockLanguageModelV4Text("").usage,
                  },
                ]),
          ];
          return Promise.resolve({
            stream:
              mode === "stream-read"
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
                : convertArrayToReadableStream(parts),
          });
        });
  return { model, requests };
}

describe.each(["direct", "stream", "stream-throw", "stream-read"] as const)(
  "%s physical exception identity",
  (mode) => {
    it.each([null, undefined, "primitive-failure"])(
      "preserves primitive %s as the wrapper cause",
      async (thrown) => {
        const { model } = fixture(mode, { thrown });
        const error = await generateModelStepResult({
          model,
          history: [{ role: "user", content: "ORIGINAL" }],
          signal: new AbortController().signal,
        }).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(PrimitiveProviderError);
        expect(error).toHaveProperty("cause", thrown);
        expect(failedRequestMessages(error)).toEqual([]);
      }
    );
    it("preserves provider object identity", async () => {
      const original = new Error("provider object");
      const { model } = fixture(mode, { thrown: original });
      const error = await generateModelStepResult({
        model,
        history: [{ role: "user", content: "ORIGINAL" }],
        signal: new AbortController().signal,
      }).catch((failure: unknown) => failure);
      expect(error).toBe(original);
      expect(failedRequestMessages(error)).toEqual([]);
    });
  }
);

it("preserves the original stream exception when followed by an error finish", async () => {
  const original = new Error("physical provider failure");
  const model = createStreamingMockLanguageModelV4([
    {
      stream: convertArrayToReadableStream<Part>([
        { type: "stream-start", warnings: [] },
        { type: "error", error: original },
        {
          type: "finish",
          finishReason: { unified: "error", raw: "fixture-error" },
          usage: mockLanguageModelV4Text("").usage,
        },
      ]),
    },
  ]);
  const error = await generateModelStepResult({
    model,
    history: [{ role: "user", content: "ORIGINAL" }],
    signal: new AbortController().signal,
  }).catch((failure: unknown) => failure);
  expect(error).toBe(original);
  expect(failedRequestMessages(error)).toEqual([]);
});

describe.each(["direct", "stream"] as const)(
  "%s provider finish identity",
  (mode) => {
    it("retains the physical unified/raw reason without inventing an HTTP error", async () => {
      const { model } = fixture(mode, { reason: "error", text: "DRAFT" });
      const error = await generateModelStepResult({
        model,
        history: [{ role: "user", content: "ORIGINAL" }],
        signal: new AbortController().signal,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProviderReportedError);
      expect(error).toMatchObject({
        finishReason: "error",
        rawFinishReason: "fixture-raw",
      });
      expect(error).not.toHaveProperty("statusCode");
      expect(failedRequestMessages(error)).toEqual([]);
    });
    it.each([null, undefined, "runtime-failure"])(
      "does not certify runtime primitive %s as a provider failure",
      async (thrown) => {
        const { model } = fixture(mode, { reason: "stop", text: "DONE" });
        const error = await generateModelStepResult({
          model,
          history: [{ role: "user", content: "ORIGINAL" }],
          signal: new AbortController().signal,
          onStreamEvent: (event) => {
            if (event.type === "assistant-output-delta") {
              throw thrown;
            }
          },
        }).catch((failure: unknown) => failure);
        expect(error).toBe(thrown);
        expect(failedRequestMessages(error)).toBeUndefined();
      }
    );
  }
);

describe.each(["memory", "file"] as const)(
  "%s provider classification",
  (kind) => {
    it.each(["direct", "stream"] as const)(
      "%s error finish retains completed same-step tools without replay",
      async (mode) => {
        const directory = await mkdtemp(
          join(tmpdir(), "pss-classification-tools-")
        );
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const requests: MockLanguageModelV4CallOptions["prompt"][] = [];
        const { usage } = mockLanguageModelV4Text("");
        let executions = 0;
        const content: MockLanguageModelV4GenerateResult["content"] = [
          { type: "text", text: "DRAFT" },
          {
            type: "tool-call",
            toolCallId: "completed",
            toolName: "count",
            input: "{}",
          },
        ];
        const model =
          mode === "direct"
            ? createMockLanguageModelV4((request) => {
                requests.push(structuredClone(request.prompt));
                return Promise.resolve(
                  requests.length === 1
                    ? {
                        content,
                        finishReason: {
                          unified: "error" as const,
                          raw: "fixture-error",
                        },
                        usage,
                        warnings: [],
                      }
                    : mockLanguageModelV4Text("DONE")
                );
              })
            : createStreamingMockLanguageModelV4((request) => {
                requests.push(structuredClone(request.prompt));
                const first = requests.length === 1;
                const parts: Part[] = [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "text" },
                  {
                    type: "text-delta",
                    id: "text",
                    delta: first ? "DRAFT" : "DONE",
                  },
                  { type: "text-end", id: "text" },
                  ...(first
                    ? [
                        {
                          type: "tool-call" as const,
                          toolCallId: "completed",
                          toolName: "count",
                          input: "{}",
                        },
                      ]
                    : []),
                  {
                    type: "finish",
                    finishReason: {
                      unified: first ? "error" : "stop",
                      raw: "fixture",
                    },
                    usage,
                  },
                ];
                return Promise.resolve({
                  stream: convertArrayToReadableStream(parts),
                });
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
                return "TOOL_RESULT";
              },
            }),
          },
        }).thread("tools");
        try {
          expect(
            (await collect(await thread.send("ORIGINAL"))).at(-1)?.type
          ).toBe("turn-error");
          expect(requests).toHaveLength(1);
          expect(executions).toBe(1);
          const continuation = await thread.continue();
          expect(continuation).toBeDefined();
          if (!continuation) {
            throw new Error("Missing continuation turn");
          }
          expect((await collect(continuation)).at(-1)?.type).toBe("turn-end");
          expect(requests).toHaveLength(2);
          expect(executions).toBe(1);
          const resumed = requests[1];
          expect(resumed).toBeDefined();
          if (!resumed) {
            throw new Error("Missing continuation request");
          }
          expect(resumed.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "tool",
          ]);
          expect(resumed[1]).toMatchObject({
            content: [{ type: "tool-call", toolName: "count" }],
          });
          expect(resumed[2]).toMatchObject({
            content: [
              {
                type: "tool-result",
                toolName: "count",
                output: { value: "TOOL_RESULT" },
              },
            ],
          });
          expect(JSON.stringify(resumed)).not.toContain("DRAFT");
          expect(await thread.continue()).toBeUndefined();
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
    const cases = [
      ...(["direct", "stream"] as const).flatMap((mode) => [
        {
          mode,
          label: "empty error finish",
          failure: { reason: "error", text: "" } as Failure,
        },
        {
          mode,
          label: "partial error finish",
          failure: { reason: "error", text: "DRAFT" } as Failure,
        },
      ]),
      ...(["direct", "stream", "stream-throw", "stream-read"] as const).flatMap(
        (mode) =>
          [null, undefined, "primitive-failure"].map((thrown) => ({
            mode,
            label: `primitive ${String(thrown)}`,
            failure: { thrown } as Failure,
          }))
      ),
    ];
    it.each(cases)(
      "$mode $label stops until an explicit manual request",
      async ({ mode, failure }) => {
        const directory = await mkdtemp(join(tmpdir(), "pss-classification-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const { model, requests } = fixture(mode, failure);
        const thread = new Agent({ host, model }).thread("classification");
        try {
          const turn = await thread.send("ORIGINAL");
          const events = await collect(turn);
          expect(events.at(-1)?.type).toBe("turn-error");
          expect(turn.runId).toBeDefined();
          if (!turn.runId) {
            throw new Error("Missing durable run ID");
          }
          expect((await host.store.turns.get(turn.runId))?.status).toBe(
            "error"
          );
          expect(requests).toHaveLength(1);
          expect(
            events.filter(
              (event) => event.type === "model-attempt" && event.phase === "end"
            )
          ).toMatchObject([{ outcome: "failed" }]);
          expect(
            events.filter(
              (event) =>
                event.type === "model-retry" && event.phase === "scheduled"
            )
          ).toEqual([]);
          expect(
            decodeStoredThreadSnapshot(
              await host.store.threads.load("classification")
            )
          ).toEqual([]);
          const continuation = await thread.continue();
          expect(continuation).toBeDefined();
          if (!continuation) {
            throw new Error("Missing continuation turn");
          }
          expect((await collect(continuation)).at(-1)?.type).toBe("turn-end");
          expect(requests).toHaveLength(2);
          expect(requests[1]).toEqual([
            { role: "user", content: [{ type: "text", text: "ORIGINAL" }] },
          ]);
          expect(
            decodeStoredThreadSnapshot(
              await host.store.threads.load("classification")
            )
          ).toEqual([
            { role: "user", content: "ORIGINAL" },
            { role: "assistant", content: [{ type: "text", text: "DONE" }] },
          ]);
          expect(await thread.continue()).toBeUndefined();
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    );

    it.each(
      (["direct", "stream"] as const).flatMap((mode) =>
        (["other", "stop", "content-filter"] as const).map((reason) => ({
          mode,
          reason,
        }))
      )
    )(
      "$mode preserves $reason as a finalized policy observation",
      async ({ mode, reason }) => {
        const directory = await mkdtemp(join(tmpdir(), "pss-classification-"));
        const host =
          kind === "file"
            ? createFileHost({ directory })
            : createInMemoryHost();
        const { model, requests } = fixture(mode, { reason, text: "" });
        const thread = new Agent({ host, model }).thread("finalized");
        try {
          const events = await collect(await thread.send("ORIGINAL"));
          expect(events.at(-1)?.type).toBe("turn-end");
          expect(
            events.filter((event) => event.type === "model-usage")
          ).toMatchObject([{ finishReason: reason }]);
          expect(requests).toHaveLength(1);
          expect(await thread.continue()).toBeUndefined();
        } finally {
          await thread.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }
);
