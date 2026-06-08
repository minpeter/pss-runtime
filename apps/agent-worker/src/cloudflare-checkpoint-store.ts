import type {
  CheckpointStore,
  CheckpointWriteResult,
  RunCheckpoint,
} from "@minpeter/pss-runtime/execution";
import {
  getRun,
  putRun,
  readList,
  storeKey,
  withTransaction,
} from "./cloudflare-store-utils";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";

export class DurableObjectCheckpointStore implements CheckpointStore {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async append(
    checkpoint: RunCheckpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const run = await getRun(storage, this.#prefix, checkpoint.runId);
      const currentVersion = run?.checkpointVersion ?? 0;
      if (currentVersion !== options.expectedVersion) {
        return {
          currentVersion,
          ok: false,
          reason: "stale-version",
        };
      }

      const checkpoints = await readList<RunCheckpoint>(
        storage,
        storeKey(this.#prefix, "checkpoints", checkpoint.runId)
      );
      checkpoints.push(structuredClone(checkpoint));
      await storage.put(
        storeKey(this.#prefix, "checkpoints", checkpoint.runId),
        checkpoints
      );
      if (run) {
        await putRun(storage, this.#prefix, {
          ...run,
          checkpointVersion: checkpoint.version,
        });
      }
      return { ok: true, version: checkpoint.version };
    });
  }

  async latest(runId: string): Promise<RunCheckpoint | null> {
    const checkpoints = await readList<RunCheckpoint>(
      this.#storage,
      storeKey(this.#prefix, "checkpoints", runId)
    );
    return checkpoints.at(-1) ?? null;
  }
}
