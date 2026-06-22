import type { AgentPlugin } from "@minpeter/pss-runtime";

export function createConversationTagPlugin(): AgentPlugin {
  return {
    name: "conversation-tag",
    on: ({ event }) => {
      if (
        event.type !== "user-input" ||
        !("text" in event) ||
        typeof event.text !== "string"
      ) {
        return;
      }

      return {
        action: "transform",
        event: {
          ...event,
          text: `[user] ${event.text}`,
        },
      };
    },
  };
}
