import type { AgentTurn } from "../../thread/protocol/turn";

export type AgentInstrumentationOperation = "resume" | "send" | "steer";

export interface AgentInstrumentationContext {
  readonly namespace?: string;
  readonly operation: AgentInstrumentationOperation;
  readonly runId?: string;
  readonly threadKey?: string;
}

export interface AgentInstrumentation {
  readonly name?: string;
  wrapTurn(turn: AgentTurn, context: AgentInstrumentationContext): AgentTurn;
}

export function normalizeAgentInstrumentations(
  value: unknown
): readonly AgentInstrumentation[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Agent: options.instrumentations must be an array.");
  }

  const instrumentations = [...value];
  for (const instrumentation of instrumentations) {
    assertAgentInstrumentation(instrumentation);
  }
  return Object.freeze(instrumentations);
}

export function applyAgentInstrumentations(
  turn: AgentTurn,
  instrumentations: readonly AgentInstrumentation[],
  context: AgentInstrumentationContext
): AgentTurn {
  let instrumentedTurn = turn;
  for (const instrumentation of instrumentations) {
    instrumentedTurn = instrumentation.wrapTurn(instrumentedTurn, context);
    assertAgentTurn(instrumentedTurn);
  }
  return instrumentedTurn;
}

function assertAgentInstrumentation(
  value: unknown
): asserts value is AgentInstrumentation {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { readonly wrapTurn?: unknown }).wrapTurn !== "function"
  ) {
    throw new TypeError(
      "Agent: each options.instrumentations entry must provide wrapTurn()."
    );
  }
}

function assertAgentTurn(value: unknown): asserts value is AgentTurn {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { readonly events?: unknown }).events !== "function"
  ) {
    throw new TypeError(
      "Agent: options.instrumentations entry wrapTurn() must return an AgentTurn."
    );
  }
}
