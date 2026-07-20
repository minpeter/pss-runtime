import type { Agent } from "@minpeter/pss-runtime";
import type { AgentHost } from "@minpeter/pss-runtime/execution";
import { resumeBackgroundDelegation } from "./app-agent-background-run";
import { resumeCompletionNotification } from "./app-agent-notification";

export function createAppAgent(options: {
  readonly coordinator: Agent;
  readonly host: AgentHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly reader: Agent;
}): Agent {
  return {
    resume: async (runId: string) => {
      const run = await options.host.store.turns.get(runId);
      if (run?.runId.startsWith("background:")) {
        return await resumeBackgroundDelegation({
          host: options.host,
          ownerNamespace: options.ownerNamespace,
          parentThreadKey: options.parentThreadKey,
          reader: options.reader,
          run,
        });
      }

      if (run?.kind === "notification" && run.dedupeKey) {
        return await resumeCompletionNotification({
          coordinator: options.coordinator,
          dedupeKey: run.dedupeKey,
          host: options.host,
          ownerNamespace: options.ownerNamespace,
          parentThreadKey: options.parentThreadKey,
          run,
        });
      }

      return await options.coordinator.resume(runId);
    },
  } as Agent;
}
