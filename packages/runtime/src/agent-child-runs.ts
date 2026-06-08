import { executionHost } from "./execution/host";
import type { AgentHost } from "./execution/types";
import { cancelBackgroundChildRun } from "./subagent-background-child-run";

export async function cancelDurableChildRuns(
  host: AgentHost,
  parentRunId: string
): Promise<void> {
  const durableHost = executionHost(host);
  if (!durableHost) {
    return;
  }

  const childRuns = await durableHost.store.runs.listByParentRunId(parentRunId);
  await Promise.all(
    childRuns.map((run) =>
      cancelBackgroundChildRun({
        executionHost: durableHost,
        runId: run.runId,
      })
    )
  );
}
