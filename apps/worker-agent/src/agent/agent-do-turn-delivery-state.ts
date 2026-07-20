import type { AgentInput } from "@minpeter/pss-runtime";

import type { ChannelAddress } from "../channel";
import type { createTurnEventCollector } from "../observability";
import type { TurnSession } from "./agent-do-turn-session";
import type { AgentDoState } from "./agent-do-types";

export async function deliverWithTurnState(
  state: AgentDoState,
  session: TurnSession,
  agentInput: AgentInput,
  turnEvents: ReturnType<typeof createTurnEventCollector>,
  channelKind: ChannelAddress["kind"],
  assistantMessages: string[]
): Promise<Awaited<ReturnType<TurnSession["deliver"]>>> {
  const previousObservability = state.observability;
  let ownsObservability = false;
  try {
    return await session.deliver(agentInput, {
      onAssistantOutput: (text) => {
        assistantMessages.push(text);
      },
      onSendStarted: () => {
        ownsObservability = true;
        state.observability = turnEvents;
        if (channelKind === "tui") {
          state.tuiMessageCapture = [];
        }
      },
    });
  } finally {
    if (ownsObservability && state.observability === turnEvents) {
      state.observability = previousObservability;
    }
  }
}
