import type {
  NotificationClaimResult,
  NotificationInbox,
  NotificationRecord,
  NotificationWriteResult,
} from "../../../execution";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { getNotification, putNotification, withTransaction } from "./records";

export class DurableObjectNotificationInbox implements NotificationInbox {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const record = await getNotification(
        storage,
        this.#prefix,
        idempotencyKey
      );
      if (!record) {
        return { ok: false, reason: "not-found" };
      }
      if (record.status !== "pending") {
        return { ok: false, reason: "already-claimed", record };
      }
      const claimed: NotificationRecord = { ...record, status: "acked" };
      await putNotification(storage, this.#prefix, claimed);
      return { ok: true, record: claimed };
    });
  }

  async enqueue(record: NotificationRecord): Promise<NotificationWriteResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await getNotification(
        storage,
        this.#prefix,
        record.idempotencyKey
      );
      if (current) {
        return {
          existingNotificationId: current.notificationId,
          ok: false,
          reason: "duplicate",
        };
      }
      await putNotification(storage, this.#prefix, record);
      return { ok: true };
    });
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    return await getNotification(this.#storage, this.#prefix, idempotencyKey);
  }

  async releaseByIdempotencyKey(idempotencyKey: string): Promise<void> {
    const record = await this.getByIdempotencyKey(idempotencyKey);
    if (record?.status === "acked") {
      await putNotification(this.#storage, this.#prefix, {
        ...record,
        status: "pending",
      });
    }
  }
}
