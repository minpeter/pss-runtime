import type { ExecutionState } from "./memory-state";
import type {
  NotificationClaimResult,
  NotificationInbox,
  NotificationRecord,
  NotificationWriteResult,
} from "./types";

export class InMemoryNotificationInbox implements NotificationInbox {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult> {
    const record = this.#state().notificationsByKey.get(idempotencyKey);
    if (!record) {
      return Promise.resolve({ ok: false, reason: "not-found" });
    }

    if (record.status !== "pending") {
      return Promise.resolve({
        ok: false,
        reason: "already-claimed",
        record: structuredClone(record),
      });
    }

    this.#state().notificationsByKey.set(idempotencyKey, {
      ...record,
      status: "acked",
    });
    return Promise.resolve({
      ok: true,
      record: structuredClone(record),
    });
  }

  enqueue(record: NotificationRecord): Promise<NotificationWriteResult> {
    const existing = this.#state().notificationsByKey.get(
      record.idempotencyKey
    );
    if (existing) {
      return Promise.resolve({
        existingNotificationId: existing.notificationId,
        ok: false,
        reason: "duplicate",
      });
    }

    this.#state().notificationsByKey.set(
      record.idempotencyKey,
      structuredClone(record)
    );
    return Promise.resolve({ ok: true });
  }

  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    const record = this.#state().notificationsByKey.get(idempotencyKey);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  releaseByIdempotencyKey(idempotencyKey: string): Promise<void> {
    const record = this.#state().notificationsByKey.get(idempotencyKey);
    if (record?.status !== "acked") {
      return Promise.resolve();
    }

    this.#state().notificationsByKey.set(idempotencyKey, {
      ...record,
      status: "pending",
    });
    return Promise.resolve();
  }
}
