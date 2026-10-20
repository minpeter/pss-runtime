import { InMemoryDurableObjectSqlStorage } from "../../sql/durable-object-test/storage";
import type { SqlStorage } from "../../sql/ports/storage-port";

export interface DurableObjectTransactionStorage {
  delete(key: string): Promise<unknown>;
  deleteAlarm?(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  getAlarm?(): Promise<number | null>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm?(scheduledTime: Date | number): Promise<void>;
  readonly sql?: unknown;
}

export interface DurableObjectStorage extends DurableObjectTransactionStorage {
  readonly sql: unknown;
  transaction?<T>(
    fn: (storage: DurableObjectTransactionStorage) => Promise<T>
  ): Promise<T>;
  transactionSync?<T>(fn: () => T): T;
}

export function withSqlStorage(
  storage: DurableObjectTransactionStorage,
  sql: unknown
): DurableObjectStorage {
  const withSql: DurableObjectStorage = {
    delete: (key) => storage.delete(key),
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    sql,
    transaction: (fn) => fn(withSql),
    transactionSync: (fn) => fn(),
  };
  if (storage.setAlarm) {
    withSql.setAlarm = (time) => storage.setAlarm?.(time) ?? Promise.resolve();
  }
  if (storage.getAlarm) {
    withSql.getAlarm = () => storage.getAlarm?.() ?? Promise.resolve(null);
  }
  if (storage.deleteAlarm) {
    withSql.deleteAlarm = () => storage.deleteAlarm?.() ?? Promise.resolve();
  }
  return withSql;
}

export class InMemoryDurableObjectStorage implements DurableObjectStorage {
  readonly sql: SqlStorage;
  #alarmTime: Date | number | undefined;
  #transactionChain: Promise<void> = Promise.resolve();
  #values = new Map<string, unknown>();

  constructor(options: { readonly sql?: SqlStorage } = {}) {
    this.sql = options.sql ?? new InMemoryDurableObjectSqlStorage();
  }

  alarmTime(): Date | number | undefined {
    return this.#alarmTime;
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }

  get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return Promise.resolve(
      value === undefined ? undefined : (structuredClone(value) as T)
    );
  }

  put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  setAlarm(scheduledTime: Date | number): Promise<void> {
    this.#alarmTime = scheduledTime;
    return Promise.resolve();
  }

  async transaction<T>(
    fn: (storage: DurableObjectTransactionStorage) => Promise<T>
  ): Promise<T> {
    const previousTransaction = this.#transactionChain;
    let releaseTransaction: () => void = () => undefined;
    this.#transactionChain = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previousTransaction;

    const transactionValues = cloneMap(this.#values);
    // Only alarm writes made by this transaction are committed, so an alarm
    // set outside it while it was open survives.
    let writtenAlarm: { readonly time: Date | number | undefined } | undefined;
    const transactionStorage = new TransactionalDurableObjectStorage({
      alarm: {
        get: () =>
          writtenAlarm === undefined ? this.#alarmTime : writtenAlarm.time,
        set: (scheduledTime) => {
          writtenAlarm = { time: scheduledTime };
        },
      },
      sql: this.sql,
      values: transactionValues,
    });

    try {
      const result = await runSqlTransaction(this.sql, () =>
        fn(transactionStorage)
      );
      this.#values = transactionValues;
      if (writtenAlarm !== undefined) {
        this.#alarmTime = writtenAlarm.time;
      }
      return result;
    } finally {
      releaseTransaction();
    }
  }

  transactionSync<T>(fn: () => T): T {
    const previousValues = cloneMap(this.#values);
    const previousAlarmTime = this.#alarmTime;
    const sql = this.sql;

    if (isTransactionalSyncSqlStorage(sql)) {
      return sql.transactionSync(() => {
        try {
          return fn();
        } catch (error) {
          this.#values = previousValues;
          this.#alarmTime = previousAlarmTime;
          throw error;
        }
      });
    }

    try {
      return fn();
    } catch (error) {
      this.#values = previousValues;
      this.#alarmTime = previousAlarmTime;
      throw error;
    }
  }
}

class TransactionalDurableObjectStorage
  implements DurableObjectTransactionStorage
{
  readonly #alarm: TransactionAlarmCell;
  readonly sql: SqlStorage;
  readonly #values: Map<string, unknown>;

  constructor({
    alarm,
    sql,
    values,
  }: {
    readonly alarm: TransactionAlarmCell;
    readonly sql: SqlStorage;
    readonly values: Map<string, unknown>;
  }) {
    this.#alarm = alarm;
    this.sql = sql;
    this.#values = values;
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }

  deleteAlarm(): Promise<void> {
    this.#alarm.set(undefined);
    return Promise.resolve();
  }

  get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return Promise.resolve(
      value === undefined ? undefined : (structuredClone(value) as T)
    );
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.#alarm.get()?.valueOf() ?? null);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  setAlarm(scheduledTime: Date | number): Promise<void> {
    this.#alarm.set(scheduledTime);
    return Promise.resolve();
  }
}

interface TransactionAlarmCell {
  get(): Date | number | undefined;
  set(scheduledTime: Date | number | undefined): void;
}

function cloneMap(values: Map<string, unknown>): Map<string, unknown> {
  return new Map(
    [...values.entries()].map(([key, value]) => [key, structuredClone(value)])
  );
}

interface TransactionalSqlStorage extends SqlStorage {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

interface TransactionalSyncSqlStorage extends SqlStorage {
  transactionSync<T>(fn: () => T): T;
}

async function runSqlTransaction<T>(
  sql: unknown,
  fn: () => Promise<T>
): Promise<T> {
  if (isTransactionalSqlStorage(sql)) {
    return await sql.transaction(fn);
  }

  return await fn();
}

function isTransactionalSqlStorage(
  value: unknown
): value is TransactionalSqlStorage {
  return (
    isSqlStorage(value) &&
    "transaction" in value &&
    typeof value.transaction === "function"
  );
}

function isTransactionalSyncSqlStorage(
  value: unknown
): value is TransactionalSyncSqlStorage {
  return (
    isSqlStorage(value) &&
    "transactionSync" in value &&
    typeof value.transactionSync === "function"
  );
}

export function isSqlStorage(value: unknown): value is SqlStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    "exec" in value &&
    typeof value.exec === "function"
  );
}
