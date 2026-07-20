import type { RunAgentLoopOptions } from "../../agent/loop/types";
import type { PluginRuntime } from "../../plugins/plugin-runtime";
import type { ThreadState } from "../state/thread-state";

interface TurnModelTransforms {
  readonly transformModelContext: RunAgentLoopOptions["transformModelContext"];
  readonly transformModelStep: RunAgentLoopOptions["transformModelStep"];
}

export function createTurnModelTransforms({
  pluginRuntime,
  state,
  threadKey,
}: {
  readonly pluginRuntime?: PluginRuntime;
  readonly state: ThreadState;
  readonly threadKey: string;
}): TurnModelTransforms {
  return {
    transformModelContext: pluginRuntime
      ? (messages, signal) =>
          pluginRuntime.transformModelContext(
            threadKey,
            messages,
            state.modelSnapshot(),
            signal
          )
      : undefined,
    transformModelStep: pluginRuntime
      ? (messages, signal) =>
          pluginRuntime.transformModelStep(
            threadKey,
            messages,
            state.modelSnapshot(),
            signal
          )
      : undefined,
  };
}
