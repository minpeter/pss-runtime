import type { AgentPlugin, UserText, UserTextContent } from "@minpeter/pss-runtime";
import { wrapPokeMessage, wrapUserMessage } from "./message-tags";

function transformUserTextContent(
  text: UserTextContent,
  wrap: (value: string) => string
): UserTextContent {
  if (typeof text === "string") {
    return wrap(text);
  }

  return text.map((part) => wrap(part));
}

function transformUserText(
  event: UserText,
  wrap: (value: string) => string
): UserText {
  return {
    ...event,
    text: transformUserTextContent(event.text, wrap),
  };
}

export function createUserTagsPlugin(): AgentPlugin {
  return {
    name: "user-tags",
    on: ({ event }) => {
      if (event.type !== "user-text" || event.meta?.source !== "send") {
        return;
      }

      return {
        action: "transform",
        event: transformUserText(event, wrapUserMessage),
      };
    },
  };
}

export function createPokeTagsPlugin(): AgentPlugin {
  return {
    name: "poke-tags",
    on: ({ event }) => {
      if (event.type !== "user-text" || event.meta?.source !== "delegate") {
        return;
      }

      return {
        action: "transform",
        event: transformUserText(event, wrapPokeMessage),
      };
    },
  };
}