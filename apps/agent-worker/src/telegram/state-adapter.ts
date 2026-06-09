import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import type { Lock, QueueEntry, StateAdapter } from "chat";

interface CachedValue<T = unknown> {
  readonly expiresAt: number | null;
  readonly value: T;
}

const statePrefix = "__pss_telegram_chat_state";

export function createDurableObjectStateAdapter(
  storage: CloudflareDurableObjectStorage
): StateAdapter {
  return new DurableObjectStateAdapter(storage);
}

class DurableObjectStateAdapter implements StateAdapter {
  readonly #storage: CloudflareDurableObjectStorage;
  #connected = false;

  constructor(storage: CloudflareDurableObjectStorage) {
    this.#storage = storage;
  }

  connect(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  async subscribe(threadId: string): Promise<void> {
    this.#ensureConnected();
    await this.#storage.put(subscriptionKey(threadId), true);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.#ensureConnected();
    await this.#storage.delete(subscriptionKey(threadId));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.#ensureConnected();
    return (
      (await this.#storage.get<boolean>(subscriptionKey(threadId))) === true
    );
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.#ensureConnected();
    return await withTransaction(this.#storage, async (storage) => {
      const existing = await storage.get<Lock>(lockKey(threadId));
      if (existing && existing.expiresAt > Date.now()) {
        return null;
      }
      const lock = {
        expiresAt: Date.now() + ttlMs,
        threadId,
        token: crypto.randomUUID(),
      };
      await storage.put(lockKey(threadId), lock);
      return lock;
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.#ensureConnected();
    await this.#storage.delete(lockKey(threadId));
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.#ensureConnected();
    await withTransaction(this.#storage, async (storage) => {
      const existing = await storage.get<Lock>(lockKey(lock.threadId));
      if (existing?.token === lock.token) {
        await storage.delete(lockKey(lock.threadId));
      }
    });
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.#ensureConnected();
    return await withTransaction(this.#storage, async (storage) => {
      const existing = await storage.get<Lock>(lockKey(lock.threadId));
      if (!existing || existing.token !== lock.token) {
        return false;
      }
      if (existing.expiresAt <= Date.now()) {
        await storage.delete(lockKey(lock.threadId));
        return false;
      }
      await storage.put(lockKey(lock.threadId), {
        ...existing,
        expiresAt: Date.now() + ttlMs,
      });
      return true;
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.#ensureConnected();
    const cached = await this.#readCached<T>(cacheKey(key));
    return cached?.value ?? null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.#ensureConnected();
    await this.#storage.put(cacheKey(key), cachedValue(value, ttlMs));
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number
  ): Promise<boolean> {
    this.#ensureConnected();
    return await withTransaction(this.#storage, async (storage) => {
      const fullKey = cacheKey(key);
      const existing = await readCached(storage, fullKey);
      if (existing) {
        return false;
      }
      await storage.put(fullKey, cachedValue(value, ttlMs));
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    this.#ensureConnected();
    await this.#storage.delete(cacheKey(key));
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { readonly maxLength?: number; readonly ttlMs?: number }
  ): Promise<void> {
    this.#ensureConnected();
    await withTransaction(this.#storage, async (storage) => {
      const fullKey = cacheKey(key);
      const existing = await readCached<readonly unknown[]>(storage, fullKey);
      const values = existing ? [...existing.value, value] : [value];
      const maxLength = options?.maxLength;
      const nextValues =
        maxLength && values.length > maxLength
          ? values.slice(values.length - maxLength)
          : values;
      await storage.put(fullKey, cachedValue(nextValues, options?.ttlMs));
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.#ensureConnected();
    const cached = await this.#readCached<readonly T[]>(cacheKey(key));
    return cached ? [...cached.value] : [];
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number
  ): Promise<number> {
    this.#ensureConnected();
    return await withTransaction(this.#storage, async (storage) => {
      const fullKey = queueKey(threadId);
      const queue = (await storage.get<readonly QueueEntry[]>(fullKey)) ?? [];
      const nextQueue = [...queue, entry].slice(-maxSize);
      await storage.put(fullKey, nextQueue);
      return nextQueue.length;
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.#ensureConnected();
    return await withTransaction(this.#storage, async (storage) => {
      const fullKey = queueKey(threadId);
      const queue = (await storage.get<readonly QueueEntry[]>(fullKey)) ?? [];
      const [entry, ...remaining] = queue;
      if (!entry) {
        return null;
      }
      if (remaining.length === 0) {
        await storage.delete(fullKey);
      } else {
        await storage.put(fullKey, remaining);
      }
      return entry;
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    this.#ensureConnected();
    const queue = await this.#storage.get<readonly QueueEntry[]>(
      queueKey(threadId)
    );
    return queue?.length ?? 0;
  }

  async #readCached<T>(key: string): Promise<CachedValue<T> | null> {
    return await readCached<T>(this.#storage, key);
  }

  #ensureConnected(): void {
    if (!this.#connected) {
      throw new Error("DurableObjectStateAdapter is not connected.");
    }
  }
}

async function readCached<T>(
  storage: CloudflareDurableObjectStorage,
  key: string
): Promise<CachedValue<T> | null> {
  const cached = await storage.get<CachedValue<T>>(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
    await storage.delete(key);
    return null;
  }
  return cached;
}

function cachedValue<T>(value: T, ttlMs: number | undefined): CachedValue<T> {
  return {
    expiresAt: ttlMs ? Date.now() + ttlMs : null,
    value,
  };
}

async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
): Promise<T> {
  return storage.transaction
    ? await storage.transaction(fn)
    : await fn(storage);
}

function cacheKey(key: string): string {
  return `${statePrefix}:cache:${encodeURIComponent(key)}`;
}

function lockKey(threadId: string): string {
  return `${statePrefix}:lock:${encodeURIComponent(threadId)}`;
}

function queueKey(threadId: string): string {
  return `${statePrefix}:queue:${encodeURIComponent(threadId)}`;
}

function subscriptionKey(threadId: string): string {
  return `${statePrefix}:subscription:${encodeURIComponent(threadId)}`;
}
