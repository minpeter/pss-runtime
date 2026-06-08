import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";

export class FailingRunLookupStorage implements CloudflareDurableObjectStorage {
  readonly #runId: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(storage: CloudflareDurableObjectStorage, runId: string) {
    this.#runId = runId;
    this.#storage = storage;
  }

  async delete(key: string): Promise<unknown> {
    return await this.#storage.delete(key);
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (key.includes(encodeURIComponent(this.#runId))) {
      throw new Error("forced run lookup failure");
    }
    return await this.#storage.get<T>(key);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.#storage.put(key, value);
  }

  async setAlarm(scheduledTime: Date | number): Promise<void> {
    await this.#storage.setAlarm?.(scheduledTime);
  }

  async transaction<T>(
    fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
  ): Promise<T> {
    if (!this.#storage.transaction) {
      return await fn(this);
    }
    return await this.#storage.transaction(
      async (storage) =>
        await fn(new FailingRunLookupStorage(storage, this.#runId))
    );
  }
}
