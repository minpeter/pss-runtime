import { join } from "node:path";
import type {
  NotificationClaimResult,
  NotificationInbox,
  NotificationRecord,
  NotificationWriteResult,
} from "../../../../execution/host/types";
import { readJsonFile, writeJsonFile } from "./json";
import { parseNotificationRecord } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileNotificationInbox implements NotificationInbox {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(idempotencyKey);
      if (!current) {
        return { ok: false, reason: "not-found" };
      }
      if (current.status !== "pending") {
        return {
          ok: false,
          reason: "already-claimed",
          record: current,
        };
      }
      const claimed: NotificationRecord = { ...current, status: "acked" };
      await this.#writeUnlocked(claimed);
      return { ok: true, record: claimed };
    });
  }

  async enqueue(record: NotificationRecord): Promise<NotificationWriteResult> {
    return await this.#lock(async () => {
      const existing = await this.#getUnlocked(record.idempotencyKey);
      if (existing) {
        return {
          existingNotificationId: existing.notificationId,
          ok: false,
          reason: "duplicate",
        };
      }
      await this.#writeUnlocked(record);
      return { ok: true };
    });
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    return await this.#lock(
      async () => await this.#getUnlocked(idempotencyKey)
    );
  }

  async releaseByIdempotencyKey(idempotencyKey: string): Promise<void> {
    await this.#lock(async () => {
      const current = await this.#getUnlocked(idempotencyKey);
      if (current?.status !== "acked") {
        return;
      }
      await this.#writeUnlocked({ ...current, status: "pending" });
    });
  }

  async #getUnlocked(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    return await readJsonFile(
      await this.#fileForIdempotencyKey(idempotencyKey),
      parseNotificationRecord,
      "notification file"
    );
  }

  async #writeUnlocked(record: NotificationRecord): Promise<void> {
    await writeJsonFile(
      await this.#fileForIdempotencyKey(record.idempotencyKey),
      record
    );
  }

  async #fileForIdempotencyKey(idempotencyKey: string): Promise<string> {
    return join(
      await this.#directory(),
      "notifications",
      `${encodeKey(idempotencyKey)}.json`
    );
  }
}
