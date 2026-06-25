import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../../../thread/store/types";
import { FileThreadStore } from "../file-thread-store";
import type { DataDirectoryResolver } from "./types";

export class LockedThreadStore implements ThreadStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    return await this.#lock(
      async () =>
        await new FileThreadStore(await this.#directory()).commit(
          key,
          next,
          options
        )
    );
  }

  async delete(key: string): Promise<void> {
    await this.#lock(async () => {
      await new FileThreadStore(await this.#directory()).delete(key);
    });
  }

  async load(key: string): Promise<StoredThread | null> {
    return await this.#lock(
      async () => await new FileThreadStore(await this.#directory()).load(key)
    );
  }
}
