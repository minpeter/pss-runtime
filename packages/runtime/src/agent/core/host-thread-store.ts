import { threadStoreFromHost } from "../../execution/host/host";
import type { AgentHost } from "../../execution/host/types";
import type { ThreadStore } from "../../thread/store/types";

export function threadStoreForHost(host: AgentHost): ThreadStore {
  return threadStoreFromHost(host);
}
