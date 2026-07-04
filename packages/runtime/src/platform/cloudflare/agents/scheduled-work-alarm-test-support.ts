import type { CloudflareAgentsFiberPayload } from "./payload";
import { resumeScheduledCloudflareAgentsFiber } from "./scheduled-fiber";
import type { FakeCloudflareAgent } from "./test-support";
import { runWithText } from "./test-support";

export function agentRecordingRuns(resumedRuns: string[]) {
  return {
    resume: (runId: string) => {
      resumedRuns.push(runId);
      return Promise.resolve(runWithText(runId));
    },
  };
}

export function resumeRecordingAgentsPayload(resumedRuns: string[]) {
  return (payload: CloudflareAgentsFiberPayload) => {
    resumedRuns.push(payload.runId);
    return Promise.resolve(runWithText(payload.runId));
  };
}

export function resumeFirstScheduledAgent(
  cloudflareAgent: FakeCloudflareAgent,
  resumedRuns: string[]
) {
  return resumeScheduledCloudflareAgentsFiber({
    allowedPrefixes: ["tenant-a"],
    cloudflareAgent,
    payload: cloudflareAgent.scheduled.at(0)?.payload,
    resume: resumeRecordingAgentsPayload(resumedRuns),
    storage: cloudflareAgent.durableObjectContext.storage,
  });
}
