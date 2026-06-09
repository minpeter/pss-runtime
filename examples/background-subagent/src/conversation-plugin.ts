import type { AgentPlugin } from "@minpeter/pss-runtime";

export function createConversationTagPlugin(): AgentPlugin {
  return {
    name: "conversation-tag",
    on: ({ event }) => {
      if (event.type !== "user-text" || typeof event.text !== "string") {
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