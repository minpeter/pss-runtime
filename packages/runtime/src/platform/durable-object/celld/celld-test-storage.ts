import { InMemoryDurableObjectStorage } from "../host/storage-host";
import type { SqlStorage } from "../sql/ports/storage-port";
import type { DurableObjectTransactionStorage } from "../storage/durable-object/durable-object-storage";
import type { CelldDurableObjectStorage } from "./scheduler-support";

interface TestStorageOptions {
  readonly setAlarm?: (scheduledTime: Date | number) => Promise<void>;
}

export function createCelldTestStorage(
  options: TestStorageOptions = {}
): CelldDurableObjectStorage & { readonly sql: SqlStorage } {
  const inner = new InMemoryDurableObjectStorage();
  let alarmTime: number | null = null;
  return {
    delete: (key) => inner.delete(key),
    deleteAlarm: () => {
      alarmTime = null;
      return Promise.resolve();
    },
    get: (key) => inner.get(key),
    getAlarm: () => Promise.resolve(alarmTime),
    put: (key, value) => inner.put(key, value),
    setAlarm: async (scheduledTime) => {
      await options.setAlarm?.(scheduledTime);
      alarmTime = alarmValue(scheduledTime);
      await inner.setAlarm(scheduledTime);
    },
    sql: inner.sql,
    // Like Durable Object storage, a transaction's alarm writes are buffered
    // and become visible only when the transaction commits.
    transaction: <T>(
      operation: (storage: DurableObjectTransactionStorage) => Promise<T>
    ): Promise<T> =>
      inner.transaction(async (transaction) => {
        let transactionAlarm = alarmTime;
        const result = await operation({
          delete: (key) => transaction.delete(key),
          deleteAlarm: async () => {
            transactionAlarm = null;
            await transaction.deleteAlarm?.();
          },
          get: (key) => transaction.get(key),
          getAlarm: () => Promise.resolve(transactionAlarm),
          put: (key, value) => transaction.put(key, value),
          setAlarm: async (scheduledTime) => {
            await options.setAlarm?.(scheduledTime);
            transactionAlarm = alarmValue(scheduledTime);
            await transaction.setAlarm?.(scheduledTime);
          },
          sql: transaction.sql ?? inner.sql,
        });
        alarmTime = transactionAlarm;
        return result;
      }),
    transactionSync: inner.transactionSync.bind(inner),
  };
}

function alarmValue(scheduledTime: Date | number): number {
  return typeof scheduledTime === "number"
    ? scheduledTime
    : scheduledTime.getTime();
}
