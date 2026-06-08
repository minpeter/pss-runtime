export interface CloudflareDurableObjectStorage {
  delete(key: string): Promise<unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm?(scheduledTime: Date | number): Promise<void>;
  transaction?<T>(
    fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
  ): Promise<T>;
}

export class InMemoryCloudflareDurableObjectStorage
  implements CloudflareDurableObjectStorage
{
  #alarmTime: Date | number | undefined;
  #transactionChain: Promise<void> = Promise.resolve();
  #values = new Map<string, unknown>();

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
    fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
  ): Promise<T> {
    const previousTransaction = this.#transactionChain;
    let releaseTransaction: () => void = () => undefined;
    this.#transactionChain = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previousTransaction;

    const transactionValues = cloneMap(this.#values);
    const transactionStorage = new TransactionalCloudflareStorage(
      transactionValues,
      (scheduledTime) => {
        this.#alarmTime = scheduledTime;
      }
    );

    try {
      const result = await fn(transactionStorage);
      this.#values = transactionValues;
      return result;
    } finally {
      releaseTransaction();
    }
  }
}

class TransactionalCloudflareStorage implements CloudflareDurableObjectStorage {
  readonly #setAlarm: (scheduledTime: Date | number) => void;
  readonly #values: Map<string, unknown>;

  constructor(
    values: Map<string, unknown>,
    setAlarm: (scheduledTime: Date | number) => void
  ) {
    this.#setAlarm = setAlarm;
    this.#values = values;
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
    this.#setAlarm(scheduledTime);
    return Promise.resolve();
  }

  async transaction<T>(
    fn: (storage: CloudflareDurableObjectStorage) => Promise<T>
  ): Promise<T> {
    return await fn(this);
  }
}

function cloneMap(values: Map<string, unknown>): Map<string, unknown> {
  return new Map(
    [...values.entries()].map(([key, value]) => [key, structuredClone(value)])
  );
}
