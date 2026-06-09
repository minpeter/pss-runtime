import {
  type Agent,
  resumeBackgroundChildRun,
} from "@minpeter/pss-runtime";
import type { ExecutionHost } from "@minpeter/pss-runtime/execution";

export function createAppAgent(options: {
  readonly coordinator: Agent;
  readonly host: ExecutionHost;
  readonly reader: Agent;
}): Agent {
  return {
    resume: async (runId: string) => {
      const run = await options.host.store.runs.get(runId);
      if (run?.kind === "background-subagent") {
        return await resumeBackgroundChildRun({
          childAgent: options.reader,
          host: options.host,
          run,
        });
      }

      return await options.coordinator.resume(runId);
    },
  } as Agent;
}