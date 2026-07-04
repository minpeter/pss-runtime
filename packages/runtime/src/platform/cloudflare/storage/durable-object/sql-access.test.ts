import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";
import {
  MissingCloudflareTransactionError,
  withTransaction,
} from "./sql-access";

describe("Cloudflare Durable Object SQL access", () => {
  it("fails fast when transaction support is missing", async () => {
    await expect(
      withTransaction(new StorageWithoutTransaction(), () =>
        Promise.resolve(undefined)
      )
    ).rejects.toBeInstanceOf(MissingCloudflareTransactionError);
  });
});

class StorageWithoutTransaction implements CloudflareDurableObjectStorage {
  readonly sql = new InMemorySqlStorage();

  delete(): Promise<unknown> {
    return Promise.resolve(false);
  }

  get<T>(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  }

  put(): Promise<void> {
    return Promise.resolve();
  }
}
