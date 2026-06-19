import type {
  CloudflareDurableObjectStorage,
  CloudflareDurableObjectTransactionStorage,
} from "../durable-object/durable-object-storage";

export async function withTransaction<T>(
  storage: CloudflareDurableObjectStorage,
  fn: (storage: CloudflareDurableObjectTransactionStorage) => Promise<T>
): Promise<T> {
  return storage.transaction
    ? await storage.transaction(fn)
    : await fn(storage);
}

export async function readList<T>(
  storage: CloudflareDurableObjectTransactionStorage,
  storageKey: string
): Promise<T[]> {
  return ((await storage.get<readonly T[]>(storageKey)) ?? []).map((item) =>
    structuredClone(item)
  );
}

export function storeKey(prefix: string, kind: string, id: string): string {
  return `${prefix}:${kind}:${id}`;
}
