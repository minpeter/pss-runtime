import type { AgentEvent } from "@minpeter/pss-runtime";

import type {
  WorkerAgentDeliveryResponse,
  WorkerAgentThreadSender,
} from "../agent/agent-do-delivery";
import { deliverToolOnlyTurn } from "../agent/agent-do-delivery";
import type {
  ChannelAddress,
  ChannelMessageSink,
  ChannelSentMessage,
} from "../channel";
import { channelKey } from "../channel";
import type { RemoteTuiDeliveryClient } from "./tui-remote";

export const WORKER_AGENT_TUI_CHANNEL: ChannelAddress = {
  id: "local",
  kind: "tui",
};
export const TUI_FAILURE_MESSAGE =
  "system: send_message was not called; no assistant text was shown.";
export const TUI_DEBUG_ASSISTANT_PREFIX = "debug assistant:";
const TUI_DEBUG_REASONING_PREFIX = "debug reasoning:";
export const TUI_DEBUG_TOOL_CALL_PREFIX = "debug tool-call:";
export const TUI_DEBUG_TOOL_RESULT_PREFIX = "debug tool-result:";
const ASSISTANT_OUTPUT_LINE_SEPARATOR = /\r\n|\n|\r/u;

export interface TuiOutput {
  writeLine(line: string): void;
}

interface DeliverTuiTurnOptions {
  readonly onAssistantOutput?: (text: string) => void;
  readonly output: TuiOutput;
  readonly text: string;
  readonly thread: WorkerAgentThreadSender;
}

interface DeliverRemoteTuiTurnOptions {
  readonly client: RemoteTuiDeliveryClient;
  readonly output: TuiOutput;
  readonly text: string;
}

class TuiMessageSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuiMessageSinkError";
  }
}

export function createTuiMessageSink(output: TuiOutput): ChannelMessageSink {
  let nextMessageIndex = 0;
  return {
    send: (channel, text): Promise<ChannelSentMessage> => {
      if (channel.kind !== "tui") {
        return Promise.reject(
          new TuiMessageSinkError("TUI sink can only send to tui channels.")
        );
      }

      nextMessageIndex += 1;
      output.writeLine(`apex: ${text}`);
      return Promise.resolve({
        channel: channelKey(channel),
        messageId: `tui-${nextMessageIndex}`,
      });
    },
  };
}

export async function deliverTuiTurn({
  onAssistantOutput,
  output,
  text,
  thread,
}: DeliverTuiTurnOptions): Promise<WorkerAgentDeliveryResponse> {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return { delivered: true };
  }

  output.writeLine(`you: ${trimmedText}`);
  const delivery = await deliverToolOnlyTurn(thread, trimmedText, {
    ...(onAssistantOutput ? { onAssistantOutput } : {}),
    onEvent: (event) => writeDebugEvent(output, event),
  });
  if (!delivery.delivered) {
    output.writeLine(TUI_FAILURE_MESSAGE);
  }

  return delivery;
}

export async function deliverRemoteTuiTurn({
  client,
  output,
  text,
}: DeliverRemoteTuiTurnOptions): Promise<WorkerAgentDeliveryResponse> {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return { delivered: true };
  }

  output.writeLine(`you: ${trimmedText}`);
  const delivery = await client.deliver(trimmedText);
  if (delivery.delivered) {
    for (const message of delivery.messages ?? []) {
      output.writeLine(`apex: ${message.text}`);
    }
    return delivery;
  }

  output.writeLine(TUI_FAILURE_MESSAGE);
  return delivery;
}

function writeDebugEvent(output: TuiOutput, event: AgentEvent): void {
  switch (event.type) {
    case "assistant-output":
      writePrefixedLines(output, TUI_DEBUG_ASSISTANT_PREFIX, event.text);
      return;
    case "assistant-reasoning":
      writePrefixedLines(output, TUI_DEBUG_REASONING_PREFIX, event.text);
      return;
    case "tool-call":
      output.writeLine(
        `${TUI_DEBUG_TOOL_CALL_PREFIX} ${event.toolName} ${stringifyDebugValue(
          event.input
        )}`
      );
      return;
    case "tool-result":
      output.writeLine(
        `${TUI_DEBUG_TOOL_RESULT_PREFIX} ${event.toolName} ${stringifyDebugValue(
          event.output
        )}`
      );
      return;
    case "turn-error":
      output.writeLine(`debug turn-error: ${event.message}`);
      return;
    default:
      return;
  }
}

function writePrefixedLines(
  output: TuiOutput,
  prefix: string,
  text: string
): void {
  for (const line of text.split(ASSISTANT_OUTPUT_LINE_SEPARATOR)) {
    output.writeLine(`${prefix} ${line}`);
  }
}

function stringifyDebugValue(value: unknown): string {
  const normalizedValue = unwrapJsonToolOutput(value);
  if (typeof normalizedValue === "string") {
    return normalizedValue;
  }

  try {
    return JSON.stringify(normalizedValue);
  } catch (error) {
    if (error instanceof TypeError) {
      return "[unserializable]";
    }
    throw error;
  }
}

function unwrapJsonToolOutput(value: unknown): unknown {
  return isJsonToolOutput(value) ? value.value : value;
}

function isJsonToolOutput(
  value: unknown
): value is { readonly type: "json"; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "json" &&
    "value" in value
  );
}
