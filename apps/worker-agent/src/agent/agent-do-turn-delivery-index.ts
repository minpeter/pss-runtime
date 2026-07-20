import type { ChannelRuntimeBinding } from "../channel";
import type { SessionIndexClient } from "../session-index/session-index-client";
import { workerErrors } from "../worker-errors";
import { logError } from "../worker-log";
import type { SendMessageToolSetup } from "./agent-do-send-message";
import { AgentDurableObjectInvariantError } from "./agent-do-types";

export async function indexTurnDelivery({
  assistantMessages,
  binding,
  sendMessage,
  sessionIndexClient,
  sessionScopeKey,
  userText,
}: {
  readonly assistantMessages: readonly string[];
  readonly binding: ChannelRuntimeBinding;
  readonly sendMessage: SendMessageToolSetup;
  readonly sessionIndexClient: SessionIndexClient;
  readonly sessionScopeKey: string | undefined;
  readonly userText: string;
}): Promise<void> {
  const delivered = sendMessage.messages().map((message) => message.text);
  const assistantText = delivered.length > 0 ? delivered : assistantMessages;
  try {
    await sessionIndexClient.upsert({
      assistantText,
      channel: binding.channel,
      ...(sessionScopeKey ? { sessionScopeKey } : {}),
      threadKey: binding.threadKey,
      userText,
    });
  } catch (error) {
    logError(
      workerErrors.SESSION_INDEX_UPSERT_FAILED({
        cause: normalizeIndexError(error),
      }),
      { scope: "agent-do" }
    );
  }
}

function normalizeIndexError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new AgentDurableObjectInvariantError(
        `Non-Error thrown: ${String(error)}`
      );
}
