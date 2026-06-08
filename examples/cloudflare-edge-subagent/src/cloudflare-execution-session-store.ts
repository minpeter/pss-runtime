import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "@minpeter/pss-runtime";
import {
  getSession,
  putSession,
  storeKey,
  withTransaction,
} from "./cloudflare-store-utils";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";

export class DurableObjectExecutionSessionStore implements SessionStore {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async commit(
    sessionKey: string,
    next: SessionStoreCommit,
    options: { readonly expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const stored = await getSession(storage, this.#prefix, sessionKey);
      const currentVersion = stored?.version ?? null;
      if (options.expectedVersion !== currentVersion) {
        return { ok: false, reason: "conflict" };
      }

      const version = String(
        ((await storage.get<number>(
          storeKey(this.#prefix, "session-version", sessionKey)
        )) ?? 0) + 1
      );
      await storage.put(
        storeKey(this.#prefix, "session-version", sessionKey),
        Number(version)
      );
      await putSession(storage, this.#prefix, sessionKey, {
        state: next.state,
        version,
      });
      return { ok: true, version };
    });
  }

  async delete(sessionKey: string): Promise<void> {
    await this.#storage.delete(storeKey(this.#prefix, "session", sessionKey));
    await this.#storage.delete(
      storeKey(this.#prefix, "session-version", sessionKey)
    );
  }

  async load(sessionKey: string): Promise<StoredSession | null> {
    return await getSession(this.#storage, this.#prefix, sessionKey);
  }
}
