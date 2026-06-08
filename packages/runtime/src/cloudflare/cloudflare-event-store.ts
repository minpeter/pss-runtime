import type { EventCursor, EventStore, StoredAgentEvent } from "../execution";
import type { AgentEvent } from "../index";
import { readList, storeKey, withTransaction } from "./cloudflare-store-utils";
import type { CloudflareDurableObjectStorage } from "./durable-object-storage";

export class DurableObjectEventStore implements EventStore {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectStorage;

  constructor(storage: CloudflareDurableObjectStorage, prefix: string) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async append(runId: string, event: AgentEvent): Promise<EventCursor> {
    return await withTransaction(this.#storage, async (storage) => {
      const events = await readList<StoredAgentEvent>(
        storage,
        storeKey(this.#prefix, "events", runId)
      );
      const cursor = { offset: events.length + 1 };
      events.push({ cursor, event: structuredClone(event), runId });
      await storage.put(storeKey(this.#prefix, "events", runId), events);
      return cursor;
    });
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    await Promise.resolve();
    const events = await readList<StoredAgentEvent>(
      this.#storage,
      storeKey(this.#prefix, "events", runId)
    );
    const start = cursor?.offset ?? 0;
    for (const event of events.slice(start)) {
      yield event;
    }
  }
}
