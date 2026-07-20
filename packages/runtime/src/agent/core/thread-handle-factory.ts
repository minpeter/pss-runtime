import type { PluginRuntime } from "../../plugins/plugin-runtime";
import type { AgentThread } from "../../thread/handle/agent-thread";
import type { AgentTurn } from "../../thread/protocol/turn";
import {
  type AgentInstrumentation,
  type AgentInstrumentationContext,
  applyAgentInstrumentations,
} from "./instrumentation";
import type { ThreadHandle } from "./thread-entry";

export function createThreadPublicHandle({
  evict,
  instrumentations,
  key,
  namespace,
  pluginRuntime,
  thread,
}: {
  readonly evict: (key: string) => void;
  readonly instrumentations: readonly AgentInstrumentation[];
  readonly key: string;
  readonly namespace: string | undefined;
  readonly pluginRuntime: PluginRuntime | undefined;
  readonly thread: AgentThread;
}): ThreadHandle {
  const instrumentTurn = (
    turn: AgentTurn,
    context: AgentInstrumentationContext
  ): AgentTurn => applyAgentInstrumentations(turn, instrumentations, context);

  const publicHandle: ThreadHandle = {
    compact: (input) => thread.compact(input),
    delete: async () => {
      evict(key);
      try {
        await thread.delete();
      } finally {
        pluginRuntime?.clearThread(key);
      }
    },
    dispose: async () => {
      evict(key);
      try {
        await thread.dispose();
      } finally {
        pluginRuntime?.clearThread(key);
      }
    },
    events: (options) => thread.events(options),
    interrupt: () => thread.interrupt(),
    overlay: (input) => {
      thread.overlay(input);
      return publicHandle;
    },
    send: async (input) =>
      instrumentTurn(await thread.send(input), {
        namespace,
        operation: "send",
        threadKey: key,
      }),
    steer: async (input) =>
      instrumentTurn(await thread.steer(input), {
        namespace,
        operation: "steer",
        threadKey: key,
      }),
  };
  return publicHandle;
}
