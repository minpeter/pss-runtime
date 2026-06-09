import type { AgentEvent } from "@minpeter/pss-runtime";

export function assistantTextFromEvents(
  events: readonly AgentEvent[]
): string | undefined {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "assistant-text" && event.text.trim()) {
      parts.push(event.text.trim());
    }
  }
  if (parts.length === 0) {
    return;
  }
  return parts.join("\n\n");
}
