import type { AgentEvent } from "./events";
import type { AgentInput } from "./session";

export type RunInput = AgentInput;

export interface AgentRunInput {
  add(input: RunInput): Promise<void>;
}

export interface AgentRun {
  readonly input: AgentRunInput;
  stream(): AsyncIterable<AgentEvent>;
}

interface AgentRunOptions {
  readonly addInput?: (input: RunInput) => Promise<void> | void;
}

interface QueuedEvent {
  readonly ack?: () => void;
  readonly event: AgentEvent;
}

interface NextWaiter {
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: IteratorResult<AgentEvent>) => void;
}

export class BufferedAgentRun implements AgentRun {
  readonly #events: QueuedEvent[] = [];
  readonly #inputHandler: (input: RunInput) => Promise<void> | void;
  #closed = false;
  #closedReason = "the run is closed";
  #error: unknown;
  #pendingAck: (() => void) | undefined;
  #resultPending = false;
  #streamStarted = false;
  #waiter: NextWaiter | undefined;

  readonly input: AgentRunInput = {
    add: async (input) => {
      if (this.#closed) {
        throw new Error(
          `AgentRun.input.add() cannot be used after ${this.#closedReason}`
        );
      }

      await this.#inputHandler(input);
    },
  };

  constructor(options: AgentRunOptions = {}) {
    this.#inputHandler = options.addInput ?? (() => undefined);
  }

  emit(event: AgentEvent): void {
    if (this.#closed) {
      return;
    }

    this.#enqueue({ event: structuredClone(event) });
  }

  emitBoundary(event: AgentEvent): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#enqueue({ ack: resolve, event: structuredClone(event) });
    });
  }

  close(error?: unknown, reason = "the run is closed"): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#closedReason = reason;
    this.#error = error;
    this.#settlePendingAck();

    if (!this.#waiter) {
      return;
    }

    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (error) {
      waiter.reject(error);
      return;
    }
    waiter.resolve({ done: true, value: undefined });
  }

  stream(): AsyncIterable<AgentEvent> {
    if (this.#streamStarted) {
      throw new Error("AgentRun.stream() can only be consumed once");
    }
    this.#streamStarted = true;

    const iterator: AsyncIterableIterator<AgentEvent> = {
      next: () => this.#next(),
      return: () => {
        this.#cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  #cancel(): void {
    this.#settleQueuedAcks();
    this.#events.length = 0;
    this.close(undefined, "stream return");
  }

  #enqueue(event: QueuedEvent): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      this.#deliver(waiter.resolve, event);
      return;
    }

    this.#events.push(event);
  }

  #next(): Promise<IteratorResult<AgentEvent>> {
    if (this.#resultPending || this.#waiter) {
      return Promise.reject(
        new Error("AgentRun.stream() does not allow concurrent next() calls")
      );
    }

    this.#settlePendingAck();

    const event = this.#events.shift();
    if (event) {
      return new Promise((resolve) => this.#deliver(resolve, event));
    }

    if (this.#closed) {
      if (this.#error) {
        return Promise.reject(this.#error);
      }
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve, reject) => {
      this.#waiter = { reject, resolve };
    });
  }

  #deliver(
    resolve: (value: IteratorResult<AgentEvent>) => void,
    { ack, event }: QueuedEvent
  ): void {
    this.#resultPending = true;
    queueMicrotask(() => {
      this.#resultPending = false;
    });
    this.#pendingAck = ack;
    resolve({ done: false, value: event });
  }

  #settlePendingAck(): void {
    const ack = this.#pendingAck;
    this.#pendingAck = undefined;
    ack?.();
  }

  #settleQueuedAcks(): void {
    for (const event of this.#events) {
      event.ack?.();
    }
  }
}
