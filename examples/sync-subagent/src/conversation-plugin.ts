import { definePlugin } from "@minpeter/pss-runtime";

export function createConversationTagPlugin() {
  return definePlugin((pss) => {
    pss.on("input.accept", (event) => {
      if (
        event.type !== "user-input" ||
        !("text" in event) ||
        typeof event.text !== "string"
      ) {
        return;
      }

      return {
        action: "transform",
        value: {
          ...event,
          text: `[user] ${event.text}`,
        },
      };
    });
  });
}
