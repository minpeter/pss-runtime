import {
  type Agent,
  type AgentRun,
  executionHost,
  resumeBackgroundChildRun,
} from "@minpeter/pss-runtime";
import type { CloudflareAlarmAgent } from "@minpeter/pss-runtime/cloudflare";

export function createAgentWorkerAlarmAgent(options: {
  readonly chatAgent: Agent;
  readonly executionAgent: Agent;
}): CloudflareAlarmAgent {
  return {
    resume: async (runId: string): Promise<AgentRun | null> => {
      const host = executionHost(options.chatAgent.host);
      if (!host) {
        throw new Error("Agent host does not support durable run resume.");
      }

      const run = await host.store.runs.get(runId);
      if (run?.kind === "background-subagent") {
        return await resumeBackgroundChildRun({
          childAgent: options.executionAgent,
          host,
          run,
        });
      }

      return await options.chatAgent.resume(runId);
    },
  };
}