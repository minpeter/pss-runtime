import {
  type DurableObjectStorage,
  InMemoryDurableObjectStorage,
  type SqlStorage,
} from "@minpeter/pss-runtime/platform/durable-object";
import type { CelldDurableObjectStorage } from "@minpeter/pss-runtime/platform/durable-object/celld";

export function createCelldTestStorage(): CelldDurableObjectStorage & {
  readonly sql: SqlStorage;
} {
  const inner = new InMemoryDurableObjectStorage();
  let alarmTime: number | null = null;
  const storage: CelldDurableObjectStorage & { readonly sql: SqlStorage } = {
    delete: (key) => inner.delete(key),
    deleteAlarm: () => {
      alarmTime = null;
      return Promise.resolve();
    },
    get: (key) => inner.get(key),
    getAlarm: () => Promise.resolve(alarmTime),
    put: (key, value) => inner.put(key, value),
    setAlarm: async (scheduledTime) => {
      alarmTime = toMilliseconds(scheduledTime);
      await inner.setAlarm(scheduledTime);
    },
    sql: inner.sql,
    // Like Durable Object storage, a transaction's alarm writes are buffered
    // and become visible only when the transaction commits.
    transaction: (operation) =>
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
            transactionAlarm = toMilliseconds(scheduledTime);
            await transaction.setAlarm?.(scheduledTime);
          },
          sql: transaction.sql ?? inner.sql,
        } satisfies DurableObjectStorage);
        alarmTime = transactionAlarm;
        return result;
      }),
    transactionSync: inner.transactionSync.bind(inner),
  };
  return storage;
}

function toMilliseconds(scheduledTime: Date | number): number {
  return typeof scheduledTime === "number"
    ? scheduledTime
    : scheduledTime.getTime();
}
