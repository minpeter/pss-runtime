import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentEvent } from "../thread/protocol/events";
import type { AgentTurn } from "../thread/protocol/turn";
import { agentEvent, agentEventStream, createMockAgentTurn } from "./index";

async function collectEvents(
  events: AsyncIterable<AgentEvent>
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("agentEvent builders", () => {
  it("builds assistant output and reasoning events", () => {
    const events: AgentEvent[] = [
      agentEvent.assistantOutput("visible text"),
      agentEvent.assistantReasoning("private chain of thought"),
    ];

    expect(events).toEqual([
      { text: "visible text", type: "assistant-output" },
      { text: "private chain of thought", type: "assistant-reasoning" },
    ]);
  });

  it("builds step and turn lifecycle events", () => {
    const events: AgentEvent[] = [
      agentEvent.turnStart(),
      agentEvent.stepStart(),
      agentEvent.stepEnd(),
      agentEvent.turnEnd(),
      agentEvent.turnAbort(),
      agentEvent.turnError("provider unavailable"),
    ];

    expect(events).toEqual([
      { type: "turn-start" },
      { type: "step-start" },
      { type: "step-end" },
      { type: "turn-end" },
      { type: "turn-abort" },
      { message: "provider unavailable", type: "turn-error" },
    ]);
  });

  it("builds tool call and tool result events with a default id", () => {
    const events: AgentEvent[] = [
      agentEvent.toolCall("search", { query: "pss" }),
      agentEvent.toolResult("search", { hits: 3 }),
    ];

    expect(events).toEqual([
      {
        input: { query: "pss" },
        toolCallId: "search-call",
        toolName: "search",
        type: "tool-call",
      },
      {
        output: { hits: 3 },
        toolCallId: "search-call",
        toolName: "search",
        type: "tool-result",
      },
    ]);
  });

  it("builds tool events with an explicit correlation id", () => {
    const call: AgentEvent = agentEvent.toolCall(
      "search",
      { query: "pss" },
      "call-42"
    );
    const result: AgentEvent = agentEvent.toolResult(
      "search",
      { hits: 3 },
      "call-42"
    );

    expect(call).toMatchObject({ toolCallId: "call-42", type: "tool-call" });
    expect(result).toMatchObject({
      toolCallId: "call-42",
      type: "tool-result",
    });
  });

  it("builds user input events", () => {
    const events: AgentEvent[] = [
      agentEvent.userText("hello"),
      agentEvent.userMessage([{ text: "hello", type: "text" }]),
    ];

    expect(events).toEqual([
      { text: "hello", type: "user-input" },
      { content: [{ text: "hello", type: "text" }], type: "user-input" },
    ]);
  });
});

describe("agentEventStream", () => {
  it("yields the given events in order", async () => {
    const events: AgentEvent[] = [
      agentEvent.turnStart(),
      agentEvent.stepStart(),
      agentEvent.assistantOutput("hi"),
      agentEvent.stepEnd(),
      agentEvent.turnEnd(),
    ];

    expect(await collectEvents(agentEventStream(events))).toEqual(events);
  });

  it("yields nothing for an empty sequence", async () => {
    expect(await collectEvents(agentEventStream([]))).toEqual([]);
  });
});

describe("createMockAgentTurn", () => {
  it("creates a turn that satisfies the public AgentTurn contract", () => {
    expectTypeOf(createMockAgentTurn([])).toMatchTypeOf<AgentTurn>();
  });

  it("replays an array of events through events()", async () => {
    const events: AgentEvent[] = [
      agentEvent.turnStart(),
      agentEvent.assistantOutput("hello"),
      agentEvent.turnEnd(),
    ];
    const turn = createMockAgentTurn(events);

    expect(await collectEvents(turn.events())).toEqual(events);
  });

  it("replays an async iterable source through events()", async () => {
    const events: AgentEvent[] = [
      agentEvent.turnStart(),
      agentEvent.assistantOutput("streamed"),
      agentEvent.turnEnd(),
    ];
    const turn = createMockAgentTurn(agentEventStream(events));

    expect(await collectEvents(turn.events())).toEqual(events);
  });

  it("propagates errors thrown by the source iterable", async () => {
    async function* failing(): AsyncIterable<AgentEvent> {
      yield agentEvent.turnStart();
      await Promise.resolve();
      throw new Error("model exploded");
    }
    const turn = createMockAgentTurn(failing());

    await expect(collectEvents(turn.events())).rejects.toThrow(
      "model exploded"
    );
  });

  it("is single-consumption like a real AgentTurn", async () => {
    const turn = createMockAgentTurn([agentEvent.turnStart()]);

    await collectEvents(turn.events());

    expect(() => turn.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );
  });

  it("rejects a second events() call even before the first is consumed", () => {
    const turn = createMockAgentTurn(agentEventStream([]));

    turn.events();

    expect(() => turn.events()).toThrow(
      "AgentTurn.events() can only be consumed once"
    );
  });
});
