import {
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  SEARCH_SESSIONS_TOOL_NAME,
} from "../session/session-tools";
import { SEND_MESSAGE_TOOL_NAME } from "../tools";
import { type ScriptedResult, scriptedToolCall } from "./scripted-model";

export function listCall(
  id: string,
  input: { readonly limit?: number } = {}
): ScriptedResult {
  return scriptedToolCall({
    input,
    toolCallId: `${id}:list`,
    toolName: LIST_SESSIONS_TOOL_NAME,
  });
}

export function searchCall(
  id: string,
  query: string,
  options: { readonly limit?: number } = {}
): ScriptedResult {
  return scriptedToolCall({
    input: { query, ...options },
    toolCallId: `${id}:search`,
    toolName: SEARCH_SESSIONS_TOOL_NAME,
  });
}

export function readCall(
  id: string,
  channel: string,
  options: { readonly before?: number; readonly limit?: number } = {}
): ScriptedResult {
  return scriptedToolCall({
    input: { channel, ...options },
    toolCallId: `${id}:read`,
    toolName: READ_SESSION_TOOL_NAME,
  });
}

export function sendCall(id: string, text: string): ScriptedResult {
  return scriptedToolCall({
    input: { text },
    toolCallId: `${id}:send`,
    toolName: SEND_MESSAGE_TOOL_NAME,
  });
}
