import type { AgentHost, ThreadStore } from "@minpeter/pss-runtime";
import { threadStoreFromHost } from "@minpeter/pss-runtime/execution";

export function threadStoreForHost(host: AgentHost): ThreadStore {
  return threadStoreFromHost(host);
}
