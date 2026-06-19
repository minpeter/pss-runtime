import { join } from "node:path";
import type { ExecutionStoreTransaction } from "../../../../execution/host/types";
import { FileCheckpointStore } from "./checkpoint-store";
import { FileEventStore } from "./event-store";
import { LockedThreadStore } from "./locked-thread-store";
import { FileNotificationInbox } from "./notification-inbox";
import { FileRunStore } from "./run-store";
import type { DataDirectoryResolver } from "./types";

export function createFileExecutionStorePorts(
  directory: DataDirectoryResolver,
  lock: <T>(fn: () => Promise<T>) => Promise<T>
): ExecutionStoreTransaction {
  const runs = new FileRunStore(directory, lock);
  return {
    checkpoints: new FileCheckpointStore(directory, lock, runs),
    events: new FileEventStore(directory, lock),
    notifications: new FileNotificationInbox(directory, lock),
    runs,
    threads: new LockedThreadStore(
      async () => join(await directory(), "threads"),
      lock
    ),
  };
}
