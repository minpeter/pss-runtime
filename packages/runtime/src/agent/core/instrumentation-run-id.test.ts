import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentInstrumentation,
  AgentInstrumentationTurn,
  AgentTurn,
} from "../../index";
import { collect } from "../../thread/handle/test-support";
import { BufferedAgentTurn } from "../../thread/protocol/turn";
import { applyAgentInstrumentations } from "./instrumentation";

const context = {
  operation: "send",
  threadKey: "thread",
} as const;

describe("instrumented AgentTurn run identity", () => {
  it.each([undefined, "forged-run"])(
    "preserves the canonical run when a wrapper returns %s",
    (wrappedRunId) => {
      // Given: a durable turn and an instrumentation that omits or forges ID.
      const turn = new BufferedAgentTurn("canonical-run");

      // When: instrumentation wraps the event surface.
      const wrapped = applyAgentInstrumentations(
        turn,
        [
          {
            wrapTurn: (source) => ({
              events: () => source.events(),
              ...(wrappedRunId === undefined ? {} : { runId: wrappedRunId }),
              [Symbol.asyncIterator]: () =>
                source.events()[Symbol.asyncIterator](),
            }),
          },
        ],
        context
      );

      // Then: the public facade exposes only the canonical immutable run ID.
      expect(wrapped.runId).toBe("canonical-run");
      expect(
        Reflect.defineProperty(wrapped, "runId", { value: "victim-run" })
      ).toBe(false);
      expect(wrapped.runId).toBe("canonical-run");
    }
  );

  it("hides producer methods from the first instrumentation", () => {
    // Given: a producer turn and instrumentation that inspects its input.
    const turn = new BufferedAgentTurn("canonical-run");
    let exposedClose: unknown;
    let exposedEmit: unknown;

    // When: the first instrumentation receives its turn.
    applyAgentInstrumentations(
      turn,
      [
        {
          wrapTurn: (source) => {
            exposedClose = Reflect.get(source, "close");
            exposedEmit = Reflect.get(source, "emit");
            return source;
          },
        },
      ],
      context
    );

    // Then: the consumer facade exposes no producer capability.
    expect(exposedClose).toBeUndefined();
    expect(exposedEmit).toBeUndefined();
  });

  it("does not read wrapper run IDs between instrumentations", async () => {
    // Given: a closed producer turn and a hostile first wrapper runId getter.
    const turn = new BufferedAgentTurn("canonical-run");
    turn.emit({ type: "turn-start" });
    turn.close();
    let hostileReads = 0;

    // When: a second instrumentation observes the first wrapper.
    const wrapped = applyAgentInstrumentations(
      turn,
      [
        {
          wrapTurn: (source) => ({
            events: () => source.events(),
            get runId(): string {
              hostileReads += 1;
              throw new Error("hostile runId getter invoked");
            },
            [Symbol.asyncIterator]: () =>
              source.events()[Symbol.asyncIterator](),
          }),
        },
        {
          wrapTurn: (source) => {
            expect(source.runId).toBe("canonical-run");
            return source;
          },
        },
      ],
      context
    );

    // Then: the canonical facade preserves identity and the event stream.
    await expect(collect(wrapped)).resolves.toEqual([{ type: "turn-start" }]);
    expect(hostileReads).toBe(0);
    expect(wrapped.runId).toBe("canonical-run");
  });

  it("accepts a wrapper that returns only events and runId", async () => {
    // Given: the documented pre-iterable wrapper shape from the public root.
    const instrumentation = {
      wrapTurn: (turn) => ({ events: () => turn.events(), runId: turn.runId }),
    } satisfies AgentInstrumentation;
    expectTypeOf<
      AgentInstrumentation["wrapTurn"]
    >().returns.toEqualTypeOf<AgentInstrumentationTurn>();
    const turn = new BufferedAgentTurn("canonical-run");
    turn.emit({ type: "turn-start" });
    turn.close();

    // When: the runtime applies it.
    const wrapped = applyAgentInstrumentations(
      turn,
      [instrumentation],
      context
    );

    // Then: the public turn is still directly iterable.
    expectTypeOf(wrapped).toEqualTypeOf<AgentTurn>();
    await expect(collect(wrapped)).resolves.toEqual([{ type: "turn-start" }]);
    expect(wrapped.runId).toBe("canonical-run");
  });
});
