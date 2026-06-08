import type { AgentHost, ExecutionHost } from "./execution/types";

export function supportsBackgroundSubagents(
  host: AgentHost,
  executionHost: ExecutionHost | undefined
): boolean {
  const capability = host.capabilities?.backgroundSubagents;
  return (
    capability === "in-process" ||
    (capability === "durable" && executionHost !== undefined)
  );
}
