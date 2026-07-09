import type { ThreadStore } from "../../thread/store/types";
import type { AgentHost } from "./types";

export function threadStoreFromHost(host: AgentHost): ThreadStore {
  const threads = host.store.threads;
  if (!threads) {
    throw new Error("AgentHost store requires a threads port");
  }
  return threads;
}
