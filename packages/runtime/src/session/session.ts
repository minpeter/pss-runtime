import { runAgentLoop } from "../agent-loop";
import type { AgentMessage, Llm } from "../llm";
import type { AgentEvent, AgentEventListener, UserText } from "./events";
import { AgentModelHistory } from "./history";

export type SessionInput = UserText;

export interface SessionOptions {
  history?: AgentMessage[];
  onHistoryChange?: (history: AgentMessage[]) => void | Promise<void>;
}

type OnHistoryChange = NonNullable<SessionOptions["onHistoryChange"]>;

interface QueuedInput {
  input: SessionInput;
  reject: (error: unknown) => void;
  resolve: () => void;
}

export class AgentSession {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #llm: Llm;
  readonly #history: AgentModelHistory;
  readonly #onHistoryChange?: OnHistoryChange;
  readonly #inputQueue: QueuedInput[] = [];
  #running = false;
  #activeAbort?: AbortController;
  readonly #killAbort = new AbortController();
  #interruptAbort = new AbortController();
  #killed = false;
  #historyPromiseChain: Promise<void> = Promise.resolve();
  readonly #pendingWrites = new Set<Promise<void>>();
  readonly #settledWriteErrors = new Set<unknown>();
  #turnErrorEmitted = false;

  constructor(llm: Llm, options?: SessionOptions) {
    this.#llm = llm;
    const { history, onHistoryChange } = options ?? {};
    this.#onHistoryChange = onHistoryChange;
    this.#history = new AgentModelHistory(
      history,
      onHistoryChange
        ? (snapshot) => this.#enqueueHistoryChange(snapshot, onHistoryChange)
        : undefined
    );
  }

  getHistory(): AgentMessage[] {
    return this.#history.modelSnapshot();
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  submit(input: SessionInput): Promise<void> {
    if (this.#killed) {
      return Promise.reject(sessionKilledError());
    }

    const acceptedInput = structuredClone(input);
    this.#emit(acceptedInput);

    if (this.#killed) {
      return Promise.reject(sessionKilledError());
    }

    const queued = new Promise<void>((resolve, reject) => {
      this.#inputQueue.push({
        input: structuredClone(acceptedInput),
        resolve,
        reject,
      });
    });

    this.#drainInputQueue().catch((error: unknown) => {
      this.#emitTurnError(error);
    });
    return queued;
  }

  interrupt(): void {
    if (!this.#activeAbort) {
      return;
    }

    this.#activeAbort.abort();
    this.#interruptAbort.abort();
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    this.#killAbort.abort();
    this.#activeAbort?.abort();

    while (this.#inputQueue.length > 0) {
      this.#inputQueue.shift()?.reject(sessionKilledError());
    }
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      while (!this.#killed && this.#inputQueue.length > 0) {
        const item = this.#inputQueue.shift();

        if (item) {
          await this.#processQueuedInput(item);
        }
      }
    } finally {
      this.#running = false;
      this.#interruptAbort = new AbortController();
    }
  }

  async #processQueuedInput(item: QueuedInput): Promise<void> {
    this.#activeAbort = new AbortController();
    const historySnapshot = this.#history.modelSnapshot();
    this.#pendingWrites.clear();
    this.#settledWriteErrors.clear();

    try {
      this.#turnErrorEmitted = false;
      this.#emit({ type: "turn-start" });
      this.#history.appendUserInput(item.input);
      const userHistoryWrite = this.#pendingHistoryWrites({
        unblockOnKill: true,
        unblockOnInterrupt: true,
      });
      if (userHistoryWrite) {
        await userHistoryWrite;
      }

      const result = await runAgentLoop({
        emit: (event) => this.#emit(event),
        history: this.#history,
        llm: this.#llm,
        signal: this.#activeAbort.signal,
      });

      const turnHistoryWrites = this.#pendingHistoryWrites({
        unblockOnKill: true,
        unblockOnInterrupt: true,
      });
      if (turnHistoryWrites) {
        await turnHistoryWrites;
      }

      const interrupted = result === "aborted";
      this.#emit({ type: interrupted ? "turn-abort" : "turn-end" });
      if (interrupted) {
        this.#interruptAbort = new AbortController();
      }
      item.resolve();
    } catch (error) {
      if (this.#killed && isSessionKilledError(error)) {
        this.#history.rollback(historySnapshot);
        this.#emit({ type: "turn-abort" });
        item.resolve();
        return;
      }

      if (isSessionInterruptedError(error)) {
        this.#repairHistoryPersistenceAfterInterruptedWait();
        this.#pendingWrites.clear();
        this.#interruptAbort = new AbortController();
        this.#emit({ type: "turn-abort" });
        item.resolve();
        return;
      }

      await this.#rollbackAndRejectInput(item, historySnapshot, error);
    } finally {
      this.#pendingWrites.clear();
      this.#activeAbort = undefined;
    }
  }

  async #rollbackAndRejectInput(
    item: QueuedInput,
    historySnapshot: AgentMessage[],
    error: unknown
  ): Promise<void> {
    this.#history.rollback(historySnapshot);
    let rejectionError = error;

    try {
      const rollbackHistoryWrite = this.#pendingHistoryWrites({
        unblockOnKill: true,
      });
      if (rollbackHistoryWrite) {
        await rollbackHistoryWrite;
      }
    } catch (rollbackOrWriteError) {
      rejectionError = mergeTurnAndPersistenceErrors(
        error,
        rollbackOrWriteError
      );
    }

    this.#emitTurnError(rejectionError);
    item.reject(rejectionError);
  }

  #enqueueHistoryChange(
    snapshot: AgentMessage[],
    onHistoryChange: OnHistoryChange
  ): void {
    const writePromise = this.#historyPromiseChain.then(async () => {
      try {
        await onHistoryChange(structuredClone(snapshot));
      } catch (error: unknown) {
        throw createPersistenceError(error);
      }
    });

    this.#historyPromiseChain = writePromise.catch(() => {
      // Keep later history writes sequenced even if this write fails.
    });
    this.#pendingWrites.add(writePromise);
    writePromise.then(
      () => this.#pendingWrites.delete(writePromise),
      (error: unknown) => {
        this.#settledWriteErrors.add(error);
        this.#pendingWrites.delete(writePromise);
      }
    );
  }

  #repairHistoryPersistenceAfterInterruptedWait(): void {
    const onHistoryChange = this.#onHistoryChange;
    if (!onHistoryChange) {
      return;
    }

    const abandonedChain = this.#historyPromiseChain;
    this.#historyPromiseChain = Promise.resolve();
    abandonedChain.then(() => {
      if (this.#killed) {
        return;
      }

      this.#enqueueHistoryChange(
        this.#history.modelSnapshot(),
        onHistoryChange
      );
    });
  }

  async #awaitPendingHistoryWrites(options?: {
    unblockOnInterrupt?: boolean;
    unblockOnKill?: boolean;
  }): Promise<void> {
    const errors: unknown[] = [];

    while (this.#pendingWrites.size > 0) {
      const writes = [...this.#pendingWrites];
      const settledWrites = Promise.allSettled(writes);
      const results = await this.#settleHistoryWrites(settledWrites, options);

      for (const result of results) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
      this.#settledWriteErrors.clear();
    }

    if (errors.length > 0) {
      throw combinePersistenceErrors(errors);
    }
  }

  #pendingHistoryWrites(options?: {
    unblockOnInterrupt?: boolean;
    unblockOnKill?: boolean;
  }): Promise<void> | undefined {
    if (this.#pendingWrites.size === 0) {
      return;
    }

    return this.#awaitPendingHistoryWrites(options);
  }

  async #settleHistoryWrites(
    writes: Promise<PromiseSettledResult<void>[]>,
    options?: { unblockOnInterrupt?: boolean; unblockOnKill?: boolean }
  ): Promise<PromiseSettledResult<void>[]> {
    if (!(options?.unblockOnKill || options?.unblockOnInterrupt)) {
      return writes;
    }

    let interruptibleWrites = writes;
    if (options.unblockOnKill) {
      interruptibleWrites = rejectOnKill(
        interruptibleWrites,
        this.#killAbort.signal
      );
    }
    if (options.unblockOnInterrupt) {
      interruptibleWrites = rejectOnInterrupt(
        interruptibleWrites,
        this.#interruptAbort.signal
      );
    }

    try {
      return await interruptibleWrites;
    } catch (error: unknown) {
      if (isSessionKilledError(error) || isSessionInterruptedError(error)) {
        await waitForAbortRaceSettlements();

        if (this.#settledWriteErrors.size > 0) {
          const settledErrors = [...this.#settledWriteErrors];
          this.#settledWriteErrors.clear();
          throw combinePersistenceErrors(settledErrors);
        }
      }

      throw error;
    }
  }

  #emitTurnError(error: unknown): void {
    if (this.#turnErrorEmitted) {
      return;
    }

    this.#turnErrorEmitted = true;
    this.#emit({ type: "turn-error", message: errorMessage(error) });
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function createPersistenceError(error: unknown): Error {
  return new Error(`onHistoryChange failed: ${errorMessage(error)}`);
}

function combinePersistenceErrors(errors: unknown[]): unknown {
  if (errors.length === 1) {
    return errors[0];
  }

  const messages = [...new Set(errors.map((error) => errorMessage(error)))];
  return new Error(`Multiple onHistoryChange failures: ${messages.join("; ")}`);
}

function mergeTurnAndPersistenceErrors(
  turnError: unknown,
  persistenceError: unknown
): unknown {
  return new Error(
    `${errorMessage(turnError)}; history rollback persistence failed: ${errorMessage(
      persistenceError
    )}`
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sessionKilledError(): Error {
  return new Error("Session killed");
}

function isSessionKilledError(error: unknown): boolean {
  return error instanceof Error && error.message === "Session killed";
}

function sessionInterruptedError(): Error {
  return new Error("Session interrupted");
}

function isSessionInterruptedError(error: unknown): boolean {
  return error instanceof Error && error.message === "Session interrupted";
}

async function waitForAbortRaceSettlements(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function rejectOnKill<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return rejectOnSignal(promise, signal, sessionKilledError);
}

function rejectOnInterrupt<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return rejectOnSignal(promise, signal, sessionInterruptedError);
}

function rejectOnSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  createError: () => Error
): Promise<T> {
  if (signal.aborted) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(createError()), 0);
    });
  }

  return new Promise((resolve, reject) => {
    let abortTimeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (abortTimeout) {
        clearTimeout(abortTimeout);
      }
    };
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      abortTimeout = setTimeout(() => {
        abortTimeout = undefined;
        reject(createError());
      }, 0);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}
