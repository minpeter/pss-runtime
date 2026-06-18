import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentRun } from "../../thread/protocol/run";
import type { EventCursor, EventStore, StoredAgentEvent } from "../host/types";

export class StoredAgentRun implements AgentRun {
  readonly #cursor: EventCursor | undefined;
  readonly #eventStore: EventStore;
  readonly #runId: string;
  #eventsStarted = false;

  constructor({
    cursor,
    eventStore,
    runId,
  }: {
    readonly cursor?: EventCursor;
    readonly eventStore: EventStore;
    readonly runId: string;
  }) {
    this.#cursor = cursor;
    this.#eventStore = eventStore;
    this.#runId = runId;
  }

  events(): AsyncIterable<AgentEvent> {
    if (this.#eventsStarted) {
      throw new Error("AgentRun.events() can only be consumed once");
    }
    this.#eventsStarted = true;

    return new StoredAgentEventIterator(
      this.#eventStore.read(this.#runId, this.#cursor)
    );
  }
}

class StoredAgentEventIterator implements AsyncIterableIterator<AgentEvent> {
  readonly #source: AsyncIterator<StoredAgentEvent>;
  #nextPending = false;

  constructor(events: AsyncIterable<StoredAgentEvent>) {
    this.#source = events[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    if (this.#nextPending) {
      throw new Error(
        "AgentRun.events() does not allow concurrent next() calls"
      );
    }

    this.#nextPending = true;
    try {
      const next = await this.#source.next();
      if (next.done) {
        return { done: true, value: undefined };
      }

      return { done: false, value: next.value.event };
    } finally {
      this.#nextPending = false;
    }
  }

  async return(): Promise<IteratorResult<AgentEvent>> {
    await this.#source.return?.();
    return { done: true, value: undefined };
  }
}
