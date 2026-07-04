import type { CloudflareDurableObjectTransactionStorage } from "../durable-object/durable-object-storage";

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
