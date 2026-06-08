import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "@minpeter/pss-runtime";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";

export class DurableObjectSessionStore implements SessionStore {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(
    storage: CloudflareDurableObjectStorage,
    options: { readonly prefix?: string } = {}
  ) {
    this.#prefix = options.prefix ?? "pss-runtime";
    this.#storage = storage;
  }

  async commit(
    key: string,
    next: SessionStoreCommit,
    options: { readonly expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    const storageKey = this.#storageKey(key);
    const current =
      (await this.#storage.get<StoredSession>(storageKey)) ?? null;
    const currentVersion = current?.version ?? null;

    if (options.expectedVersion !== currentVersion) {
      return { ok: false, reason: "conflict" };
    }

    const version = crypto.randomUUID();
    await this.#storage.put(storageKey, { state: next.state, version });
    return { ok: true, version };
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(this.#storageKey(key));
  }

  async load(key: string): Promise<StoredSession | null> {
    return (
      (await this.#storage.get<StoredSession>(this.#storageKey(key))) ?? null
    );
  }

  #storageKey(key: string): string {
    return `${this.#prefix}:${encodeURIComponent(key)}`;
  }
}
