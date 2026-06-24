// biome-ignore-all lint/performance/noBarrelFile: Public package subpath entrypoint required by package exports.
import type { AgentEvent, AgentInput, ThreadKey } from "../index";

export interface ChannelInboundMessage {
  readonly input: AgentInput;
  readonly threadKey: ThreadKey;
}

export interface ChannelAssistantTextDelivery {
  readonly text: string;
  readonly type: "assistant-text";
}

export type ChannelAssistantDelivery = ChannelAssistantTextDelivery;

export function projectChannelAssistantDelivery(
  event: AgentEvent
): ChannelAssistantDelivery | undefined {
  if (event.type !== "assistant-output" || !event.text?.trim()) {
    return;
  }

  return { text: event.text, type: "assistant-text" };
}
