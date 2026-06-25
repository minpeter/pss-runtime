import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent/core/agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../testing/mock-language-model-v4-test-utils";
import type { AgentEvent } from "../thread/protocol/events";
import type { AgentTurn } from "../thread/protocol/turn";
import { openTelemetry, traceAgentTurn } from "./index";
import {
  collectEvents,
  eventTypes,
  RecordingTracer,
  spanNamed,
} from "./test-support";

describe("traceAgentTurn", () => {
  it("creates an Agent instrumentation for constructor-level tracing", async () => {
    const tracer = new RecordingTracer();
    const agent = new Agent({
      instrumentations: [
        openTelemetry({
          spanAttributes: { "test.case": "agent-instrumentation" },
          tracer,
        }),
      ],
      model: createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]),
    });

    const collected = await collectEvents((await agent.send("hello")).events());

    expect(collected.map((event) => event.type)).toContain("assistant-output");
    expect(collected.map((event) => event.type)).toContain("turn-end");
    expect(spanNamed(tracer, "pss.runtime.turn").spanAttributes).toMatchObject({
      "pss.runtime.component": "@minpeter/pss-runtime",
      "pss.runtime.span.kind": "turn",
      "test.case": "agent-instrumentation",
    });
    expect(spanNamed(tracer, "pss.runtime.turn").ended).toBe(true);
  });

  it("returns an AgentTurn that yields original events and records spans", async () => {
    const sourceEvents = [
      { meta: { source: "send" }, text: "private user", type: "user-input" },
      { type: "turn-start" },
      { type: "step-start" },
      { text: "private answer", type: "assistant-output" },
      { text: "private reasoning", type: "assistant-reasoning" },
      {
        input: { query: "private tool input" },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-call",
      },
      {
        output: { result: "private tool output" },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-result",
      },
      { type: "step-end" },
      { type: "turn-end" },
    ] satisfies readonly AgentEvent[];
    const tracer = new RecordingTracer();
    const tracedTurn = traceAgentTurn(turnFrom(sourceEvents), {
      eventAttributes: (event) =>
        event.type === "turn-start" ? { "test.extra": "kept" } : undefined,
      spanAttributes: { "test.case": "happy" },
      tracer,
    });

    expect(tracedTurn.events).toEqual(expect.any(Function));
    const collected = await collectEvents(tracedTurn.events());

    expect(collected).toHaveLength(sourceEvents.length);
    expect(collected[0]).toBe(sourceEvents[0]);
    expect(collected[3]).toBe(sourceEvents[3]);
    expect(collected[6]).toBe(sourceEvents[6]);
    expect(tracer.spans.map((span) => span.name)).toEqual([
      "pss.runtime.turn",
      "pss.runtime.step",
      "pss.runtime.tool",
    ]);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.OK,
    });
    expect(spanNamed(tracer, "pss.runtime.turn").spanAttributes).toMatchObject({
      "pss.runtime.component": "@minpeter/pss-runtime",
      "pss.runtime.span.kind": "turn",
      "test.case": "happy",
    });
    expect(eventTypes(spanNamed(tracer, "pss.runtime.turn"))).toEqual(
      sourceEvents.map((event) => event.type)
    );
    expect(eventAttributesFor(tracer, "turn-start")).toMatchObject({
      "pss.event.type": "turn-start",
      "test.extra": "kept",
    });
    expect(eventAttributesFor(tracer, "tool-call")).toMatchObject({
      "pss.tool.call_id": "call-1",
      "pss.tool.input.type": "object",
      "pss.tool.name": "search",
    });
  });

  it("keeps default telemetry metadata-only, including errors", async () => {
    const secrets = [
      "private user",
      "private image",
      "private file",
      "private runtime input",
      "private answer",
      "private reasoning",
      "private tool input",
      "private failure",
    ];
    const tracer = new RecordingTracer();

    await collectEvents(
      traceAgentTurn(
        turnFrom([
          {
            content: [
              { text: secrets[0], type: "text" },
              { image: secrets[1], type: "image" },
              {
                data: { text: secrets[2], type: "text" },
                mediaType: "text/plain",
                type: "file",
              },
            ],
            meta: { source: "send" },
            type: "user-input",
          },
          {
            input: { text: secrets[3], type: "user-input" },
            meta: { source: "notify" },
            placement: "turn-start",
            type: "runtime-input",
          },
          { type: "turn-start" },
          { type: "step-start" },
          { text: secrets[4], type: "assistant-output" },
          { text: secrets[5], type: "assistant-reasoning" },
          {
            input: { secret: secrets[6] },
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
          { message: secrets[7], type: "turn-error" },
        ]),
        { tracer }
      ).events()
    );

    const telemetry = JSON.stringify({
      exceptions: tracer.spans.flatMap((span) =>
        span.exceptions.map((error) => error.message)
      ),
      spans: tracer.spans,
      statuses: tracer.spans.map((span) => span.status),
    });
    for (const secret of secrets) {
      expect(telemetry).not.toContain(secret);
    }
    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "turn error",
    });
    expect(
      spanNamed(tracer, "pss.runtime.turn").exceptions.map(
        (error) => error.message
      )
    ).toEqual(["Agent turn failed"]);
    expect(eventAttributesFor(tracer, "user-input")).toMatchObject({
      "pss.input.source": "send",
      "pss.user_input.file_count": 1,
      "pss.user_input.image_count": 1,
      "pss.user_input.text_part_count": 1,
    });
    expect(eventAttributesFor(tracer, "runtime-input")).toMatchObject({
      "pss.input.source": "notify",
      "pss.runtime_input.kind": "text",
      "pss.runtime_input.text_length": secrets[3].length,
    });
  });

  it("does not let payload summarization consume or throw from tool payloads", async () => {
    const sourceEvents = [
      { type: "turn-start" },
      {
        input: {
          secret: "private tool input",
          toJSON: () => {
            throw new Error("payload side effect");
          },
        },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-call",
      },
      {
        output: {
          result: "private tool output",
          toJSON: () => {
            throw new Error("payload side effect");
          },
        },
        toolCallId: "call-1",
        toolName: "search",
        type: "tool-result",
      },
      { type: "turn-end" },
    ] satisfies readonly AgentEvent[];
    const tracer = new RecordingTracer();

    const collected = await collectEvents(
      traceAgentTurn(turnFrom(sourceEvents), { tracer }).events()
    );

    expect(collected[1]).toBe(sourceEvents[1]);
    expect(collected[2]).toBe(sourceEvents[2]);
    expect(eventAttributesFor(tracer, "tool-call")).toMatchObject({
      "pss.tool.call_id": "call-1",
      "pss.tool.input.key_count": 2,
      "pss.tool.input.type": "object",
    });
    expect(eventAttributesFor(tracer, "tool-result")).toMatchObject({
      "pss.tool.call_id": "call-1",
      "pss.tool.output.key_count": 2,
      "pss.tool.output.type": "object",
    });
    expect(JSON.stringify(tracer.spans)).not.toContain("private tool");
  });

  it("handles aborts, orphan tool results, duplicate tools, and step replacement", async () => {
    const tracer = new RecordingTracer();

    await collectEvents(
      traceAgentTurn(
        turnFrom([
          { type: "turn-start" },
          { type: "step-start" },
          { type: "step-start" },
          {
            input: "first",
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
          {
            input: "second",
            toolCallId: "call-1",
            toolName: "search",
            type: "tool-call",
          },
          {
            output: "done",
            toolCallId: "missing",
            toolName: "lookup",
            type: "tool-result",
          },
          { type: "turn-abort" },
        ]),
        { tracer }
      ).events()
    );

    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "turn aborted",
    });
    expect(
      spanNamed(tracer, "pss.runtime.turn")
        .events.filter((event) => event.name === "pss.runtime.diagnostic")
        .map((event) => event.attributes?.["pss.diagnostic.reason"])
    ).toEqual([
      "step span replaced",
      "tool span replaced",
      "orphan tool result",
    ]);
    expect(
      tracer.spans.filter((span) => span.name === "pss.runtime.step")
    ).toHaveLength(2);
    expect(
      tracer.spans.filter((span) => span.name === "pss.runtime.tool")
    ).toHaveLength(2);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });
});

async function* eventsFrom(events: readonly AgentEvent[]) {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

function eventAttributesFor(tracer: RecordingTracer, type: AgentEvent["type"]) {
  const event = spanNamed(tracer, "pss.runtime.turn").events.find(
    (candidate) => candidate.attributes?.["pss.event.type"] === type
  );
  if (!event?.attributes) {
    throw new Error(`Missing recorded event attributes for ${type}`);
  }
  return event.attributes;
}

function turnFrom(events: readonly AgentEvent[]): AgentTurn {
  return {
    events: () => eventsFrom(events),
  };
}
