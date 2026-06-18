import type { AgentEvent } from "./events";

export interface AgentRun {
  events(): AsyncIterable<AgentEvent>;
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
  #closed = false;
  #error: unknown;
  #pendingAck: (() => void) | undefined;
  #resultPending = false;
  #eventsStarted = false;
  #waiter: NextWaiter | undefined;

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

  close(error?: unknown): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#error = error;
    this.#settlePendingAck();
    this.#settleQueuedAcks();

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

  events(): AsyncIterable<AgentEvent> {
    if (this.#eventsStarted) {
      throw new Error("AgentRun.events() can only be consumed once");
    }
    this.#eventsStarted = true;

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
    this.close();
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
        new Error("AgentRun.events() does not allow concurrent next() calls")
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
