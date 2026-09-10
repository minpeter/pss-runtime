import type { ModelMessage } from "ai";

const stopped = new WeakMap<object, StoppedModelStep>();
export function recordStoppedModelStep(
  error: unknown,
  messages: readonly ModelMessage[]
): void {
  if (typeof error === "object" && error !== null) {
    stopped.set(error, new StoppedModelStep("aborted", messages));
  }
}
export function takeStoppedModelStep(
  error: unknown
): StoppedModelStep | undefined {
  if (typeof error !== "object" || error === null) {
    return;
  }
  const output = stopped.get(error);
  stopped.delete(error);
  return output;
}

/** Only the model boundary can certify an aborted step's safe output. */
export class StoppedModelStep extends Error {
  readonly name = "StoppedModelStep";
  readonly reason: "aborted" | "length";
  readonly messages: readonly ModelMessage[];
  constructor(reason: "aborted" | "length", messages: readonly ModelMessage[]) {
    super(`Model step stopped: ${reason}`);
    this.reason = reason;
    this.messages = messages;
  }
}

/** A live tool ledger, not a new model request, must resolve uncertain effects. */
export class StoppedToolRecoveryError extends Error {
  readonly name = "StoppedToolRecoveryError";
  readonly recover: () => readonly ModelMessage[];
  constructor(recover: () => readonly ModelMessage[]) {
    super(
      "Tool execution requires recovery. Reconcile the recorded execution before continuing; do not replay the tool."
    );
    this.recover = recover;
  }
}
