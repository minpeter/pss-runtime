export interface ResumeThreadOptions {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId: string;
}
