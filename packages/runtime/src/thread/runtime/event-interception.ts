import type { ModelMessage } from "ai";
import type { RuntimeToolExecutionCheckpoint } from "../../llm/tool-execution-types";
import type {
  InputAcceptEvent,
  PluginToolCallBeforeEvent,
} from "../../plugins/api";
import type { PluginRuntime } from "../../plugins/plugin-runtime";
import {
  type HostAttachmentStore,
  type RuntimeAttachmentReference,
  stageAgentEventAttachments,
} from "../input/attachments";
import type { AgentEvent } from "../protocol/events";

interface InterceptAgentEventOptions {
  readonly attachmentStore?: HostAttachmentStore;
  readonly history: () => readonly ModelMessage[];
  readonly pluginRuntime?: PluginRuntime;
  readonly signal: () => AbortSignal;
  readonly stagedRefs?: RuntimeAttachmentReference[];
  readonly threadKey: string;
}

export async function interceptAgentEvent(
  event: AgentEvent,
  options: InterceptAgentEventOptions
): Promise<AgentEvent | "handled"> {
  let processed: AgentEvent | "handled" = event;
  if (isInputAcceptEvent(event) && options.pluginRuntime) {
    processed = await options.pluginRuntime.interceptInput(
      options.threadKey,
      event,
      options.history(),
      options.signal()
    );
  } else {
    await options.pluginRuntime?.observeAgentEvent(
      options.threadKey,
      event,
      options.history(),
      options.signal()
    );
  }

  if (processed === "handled") {
    return "handled";
  }
  return stageAgentEventAttachments(processed, options.attachmentStore, {
    stagedRefs: options.stagedRefs,
    trustRuntimeAttachmentRefs: true,
  });
}

export function beforeToolCallEvent(
  checkpoint: RuntimeToolExecutionCheckpoint
): PluginToolCallBeforeEvent {
  return {
    attempt: checkpoint.attempt,
    idempotencyKey: checkpoint.idempotencyKey,
    input: checkpoint.input,
    policy: checkpoint.policy,
    toolCallId: checkpoint.toolCallId,
    toolName: checkpoint.toolName,
    type: "tool.call.before",
  };
}

function isInputAcceptEvent(event: AgentEvent): event is InputAcceptEvent {
  return event.type === "runtime-input" || event.type === "user-input";
}
