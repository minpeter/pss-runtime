import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointStore,
  CheckpointWriteResult,
  RunCheckpoint,
} from "../../../../execution/host/types";
import { readJsonFile, writeJsonFile } from "./json";
import type { FileRunStore } from "./run-store";
import { parseRunCheckpoint } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey, isNodeError } from "./utils";

export class FileCheckpointStore implements CheckpointStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly #runs: FileRunStore;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>,
    runs: FileRunStore
  ) {
    this.#directory = directory;
    this.#lock = lock;
    this.#runs = runs;
  }

  async append(
    checkpoint: RunCheckpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    return await this.#lock(async () => {
      const current = await this.latestUnlocked(checkpoint.runId);
      const currentVersion = current?.version ?? 0;
      if (options.expectedVersion !== currentVersion) {
        return {
          currentVersion,
          ok: false,
          reason: "stale-version",
        };
      }

      await writeJsonFile(
        await this.#fileForCheckpoint(checkpoint.runId, checkpoint.version),
        checkpoint
      );
      await this.#runs.updateCheckpointVersion(
        checkpoint.runId,
        checkpoint.version
      );
      return { ok: true, version: checkpoint.version };
    });
  }

  async latest(runId: string): Promise<RunCheckpoint | null> {
    return await this.#lock(async () => await this.latestUnlocked(runId));
  }

  async latestUnlocked(runId: string): Promise<RunCheckpoint | null> {
    const directory = join(
      await this.#directory(),
      "checkpoints",
      encodeKey(runId)
    );
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const versions = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => Number(entry.slice(0, -".json".length)))
      .filter((version) => Number.isSafeInteger(version) && version > 0)
      .sort((left, right) => right - left);

    if (versions.length === 0) {
      return null;
    }

    return await readJsonFile(
      await this.#fileForCheckpoint(runId, versions[0]),
      parseRunCheckpoint,
      "checkpoint file"
    );
  }

  async #fileForCheckpoint(runId: string, version: number): Promise<string> {
    return join(
      await this.#directory(),
      "checkpoints",
      encodeKey(runId),
      `${version}.json`
    );
  }
}
