import type { AgentEvent } from "./events";

export interface AgentRun {
  stream(): AsyncIterable<AgentEvent>;
}

export class BufferedAgentRun implements AgentRun {
  readonly #events: AgentEvent[] = [];
  readonly #waiters: Array<{
    reject: (error: unknown) => void;
    resolve: (value: IteratorResult<AgentEvent>) => void;
  }> = [];
  #closed = false;
  #error: unknown;
  #streamStarted = false;

  emit(event: AgentEvent): void {
    if (this.#closed) {
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return;
    }

    this.#events.push(structuredClone(event));
  }

  close(error?: unknown): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#error = error;

    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (!waiter) {
        continue;
      }

      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }
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
    this.#events.length = 0;
    this.close();
  }

  #next(): Promise<IteratorResult<AgentEvent>> {
    const event = this.#events.shift();
    if (event) {
      return Promise.resolve({ done: false, value: event });
    }

    if (this.#closed) {
      if (this.#error) {
        return Promise.reject(this.#error);
      }
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve, reject) => {
      this.#waiters.push({ reject, resolve });
    });
  }
}
