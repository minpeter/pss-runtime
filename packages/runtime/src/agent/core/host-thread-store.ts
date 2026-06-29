import { threadHost } from "../../execution/host/host";
import type { AgentHost } from "../../execution/host/types";
import { MemoryThreadStore } from "../../platform/memory/storage/memory-thread-store";
import type { ThreadStore } from "../../thread/store/types";

export function threadStoreForHost(host: AgentHost): ThreadStore {
  return threadHost(host).threadStore ?? new MemoryThreadStore();
}
