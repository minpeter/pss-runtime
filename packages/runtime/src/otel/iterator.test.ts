import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../thread/protocol/events";
import type { AgentTurn } from "../thread/protocol/turn";
import { traceAgentTurn } from "./index";
import { collectEvents, RecordingTracer, spanNamed } from "./test-support";

describe("traceAgentTurn iterator behavior", () => {
  it("propagates source errors after closing spans with sanitized telemetry", async () => {
    const tracer = new RecordingTracer();

    await expect(
      collectEvents(
        traceAgentTurn(throwingTurn(new Error("private source failure")), {
          tracer,
        }).events()
      )
    ).rejects.toThrow("private source failure");

    const telemetry = JSON.stringify({
      exceptions: tracer.spans.flatMap((span) =>
        span.exceptions.map((error) => error.message)
      ),
      statuses: tracer.spans.map((span) => span.status),
    });
    expect(telemetry).not.toContain("private source failure");
    expect(spanNamed(tracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "source iterator failed",
    });
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });

  it("preserves second events() and concurrent next() failures", async () => {
    const tracedTurn = traceAgentTurn(singleUseTurn([{ type: "turn-start" }]), {
      tracer: new RecordingTracer(),
    });
    tracedTurn.events();

    expect(() => tracedTurn.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );

    const deferred = createDeferred<IteratorResult<AgentEvent>>();
    const iterator = traceAgentTurn(
      turnFromIterator({
        next: () => deferred.promise,
      }),
      { tracer: new RecordingTracer() }
    )
      .events()
      [Symbol.asyncIterator]();
    const firstNext = iterator.next();

    await expect(iterator.next()).rejects.toThrow(
      "AgentTurn.events() does not allow concurrent next() calls"
    );
    deferred.resolve({ done: false, value: { type: "turn-start" } });
    await expect(firstNext).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });
  });

  it("calls source return() and closes spans on early return", async () => {
    let sourceReturned = false;
    const tracer = new RecordingTracer();
    const iterator = traceAgentTurn(
      {
        events: () =>
          (async function* () {
            try {
              yield { type: "turn-start" } satisfies AgentEvent;
              await new Promise(() => undefined);
            } finally {
              sourceReturned = true;
            }
          })(),
      },
      { tracer }
    )
      .events()
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn-start" },
    });
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(sourceReturned).toBe(true);
    expect(spanNamed(tracer, "pss.runtime.turn").ended).toBe(true);
    expect(spanNamed(tracer, "pss.runtime.turn").status).toBeUndefined();
  });

  it("closes open spans on source completion and allows an empty stream", async () => {
    const partialTracer = new RecordingTracer();
    const partialEvents = await collectEvents(
      traceAgentTurn(
        singleUseTurn([
          { text: "visible only to source", type: "assistant-output" },
        ]),
        { tracer: partialTracer }
      ).events()
    );

    expect(partialEvents).toHaveLength(1);
    expect(spanNamed(partialTracer, "pss.runtime.turn").status).toEqual({
      code: SpanStatusCode.OK,
    });
    expect(spanNamed(partialTracer, "pss.runtime.turn").ended).toBe(true);

    const emptyTracer = new RecordingTracer();
    expect(
      await collectEvents(
        traceAgentTurn(singleUseTurn([]), { tracer: emptyTracer }).events()
      )
    ).toEqual([]);
    expect(emptyTracer.spans).toEqual([]);
  });
});

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function* eventsFrom(events: readonly AgentEvent[]) {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

function singleUseTurn(events: readonly AgentEvent[]): AgentTurn {
  let started = false;
  return {
    events: () => {
      if (started) {
        throw new Error("AgentTurn.events() can only be consumed once");
      }
      started = true;
      return eventsFrom(events);
    },
  };
}

function throwingTurn(error: Error): AgentTurn {
  return {
    events: () =>
      (async function* () {
        await Promise.resolve();
        yield { type: "turn-start" } satisfies AgentEvent;
        yield { type: "step-start" } satisfies AgentEvent;
        throw error;
      })(),
  };
}

function turnFromIterator(iterator: AsyncIterator<AgentEvent>): AgentTurn {
  return {
    events: () => ({
      ...iterator,
      [Symbol.asyncIterator]: () => iterator,
    }),
  };
}
