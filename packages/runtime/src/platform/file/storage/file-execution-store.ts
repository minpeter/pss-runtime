import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointStore,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationInbox,
  TurnStore,
} from "../../../execution/host/types";
import type { ThreadStore } from "../../../thread/store/types";
import {
  copyDataDirectories,
  currentDataDirectory,
  GENERATIONS_DIRECTORY,
  writeCurrentGeneration,
} from "./file-execution-store/generation";
import {
  createFileExecutionLock,
  withFileLock,
} from "./file-execution-store/lock";
import { createFileExecutionStorePorts } from "./file-execution-store/ports";

export class FileExecutionStore implements ExecutionStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly notifications: NotificationInbox;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;

  readonly #directory: string;
  readonly #lockDirectory: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#lockDirectory = join(directory, ".execution.lock");
    const ports = createFileExecutionStorePorts(
      () => currentDataDirectory(directory),
      createFileExecutionLock(this.#lockDirectory, "auto")
    );

    this.turns = ports.turns;
    this.events = ports.events;
    this.checkpoints = ports.checkpoints;
    this.notifications = ports.notifications;
    this.threads = ports.threads;
  }

  async transaction<T>(
    fn: (tx: ExecutionStoreTransaction) => Promise<T>
  ): Promise<T> {
    return await withFileLock(
      this.#lockDirectory,
      "FileExecutionStore transaction",
      async () => {
        await mkdir(this.#directory, { recursive: true });
        const generationId = `transaction-${process.pid}-${randomUUID()}`;
        const transactionDirectory = join(
          this.#directory,
          GENERATIONS_DIRECTORY,
          generationId
        );
        await mkdir(transactionDirectory, { recursive: true });

        let committed = false;
        try {
          await copyDataDirectories(
            await currentDataDirectory(this.#directory),
            transactionDirectory
          );
          const tx = createFileExecutionStorePorts(
            () => Promise.resolve(transactionDirectory),
            createFileExecutionLock(this.#lockDirectory, "held")
          );
          const result = await fn(tx);
          await writeCurrentGeneration(this.#directory, generationId);
          committed = true;
          return result;
        } finally {
          if (!committed) {
            await rm(transactionDirectory, { force: true, recursive: true });
          }
        }
      }
    );
  }
}
