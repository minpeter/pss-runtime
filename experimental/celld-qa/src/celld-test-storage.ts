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
    // Like Durable Object storage, only alarm writes made by a transaction are
    // committed, and only when it succeeds.
    transaction: (operation) =>
      inner.transaction(async (transaction) => {
        let written: { readonly alarm: number | null } | undefined;
        const result = await operation({
          delete: (key) => transaction.delete(key),
          deleteAlarm: async () => {
            written = { alarm: null };
            await transaction.deleteAlarm?.();
          },
          get: (key) => transaction.get(key),
          getAlarm: () =>
            Promise.resolve(written === undefined ? alarmTime : written.alarm),
          put: (key, value) => transaction.put(key, value),
          setAlarm: async (scheduledTime) => {
            written = { alarm: toMilliseconds(scheduledTime) };
            await transaction.setAlarm?.(scheduledTime);
          },
          sql: transaction.sql ?? inner.sql,
        } satisfies DurableObjectStorage);
        if (written !== undefined) {
          alarmTime = written.alarm;
        }
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
