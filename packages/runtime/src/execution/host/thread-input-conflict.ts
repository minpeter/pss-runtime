import type { AdmitThreadInput, ThreadInputRecord } from "./types";

export class ThreadInputDuplicateConflictError extends Error {
  readonly existing: ThreadInputRecord;
  readonly incoming: AdmitThreadInput;
  readonly name = "ThreadInputDuplicateConflictError";

  constructor({
    existing,
    incoming,
  }: {
    readonly existing: ThreadInputRecord;
    readonly incoming: AdmitThreadInput;
  }) {
    super(
      `Thread input messageId ${incoming.messageId} conflicts with an existing semantic payload.`
    );
    this.existing = structuredClone(existing);
    this.incoming = structuredClone(incoming);
  }
}
