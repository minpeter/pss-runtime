import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createEventCursor,
  createThreadEventCursor,
  normalizeEventCursor,
  normalizeThreadEventReadOptions,
} from "../../../../execution/host/event-cursors";
import type {
  EventCursor,
  EventStore,
  StoredAgentEvent,
  StoredThreadEvent,
  ThreadEventCursor,
  ThreadEventLog,
  ThreadEventReadOptions,
} from "../../../../execution/host/types";
import { isNodeError } from "../../../../internal/guards";
import type { AgentEvent } from "../../../../thread/protocol/events";
import {
  parseEventLogLine,
  parseThreadEventLogLine,
} from "./event-log-schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileEventStore implements EventStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async append(runId: string, event: AgentEvent): Promise<EventCursor> {
    return await this.#lock(async () =>
      createEventCursor(
        await appendJsonlEntry(await this.#fileForRun(runId), (offset) => ({
          cursor: { offset },
          event,
          runId,
        }))
      )
    );
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    const start = normalizeEventCursor(cursor);
    const events = await this.#lock(async () =>
      readJsonlEntries(await this.#fileForRun(runId), parseEventLogLine)
    );
    for (const event of events.slice(start)) {
      yield structuredClone(event);
    }
  }
  async #fileForRun(runId: string): Promise<string> {
    return join(await this.#directory(), "events", `${encodeKey(runId)}.jsonl`);
  }
}

export class FileThreadEventLog implements ThreadEventLog {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async append(
    threadKey: string,
    event: AgentEvent
  ): Promise<ThreadEventCursor> {
    return await this.#lock(async () =>
      createThreadEventCursor(
        await appendJsonlEntry(
          await this.#fileForThread(threadKey),
          (offset) => ({
            cursor: { offset },
            event,
            threadKey,
          })
        )
      )
    );
  }

  async *read(
    threadKey: string,
    options: ThreadEventReadOptions = {}
  ): AsyncIterable<StoredThreadEvent> {
    const { limit, start } = normalizeThreadEventReadOptions(options);
    const events = await this.#lock(async () =>
      readJsonlEntries(
        await this.#fileForThread(threadKey),
        parseThreadEventLogLine
      )
    );
    const end = limit === undefined ? undefined : start + limit;
    for (const event of events.slice(start, end)) {
      yield structuredClone(event);
    }
  }
  async #fileForThread(threadKey: string): Promise<string> {
    return join(
      await this.#directory(),
      "thread-events",
      `${encodeKey(threadKey)}.jsonl`
    );
  }
}

async function appendJsonlEntry(
  file: string,
  createPayload: (offset: number) => unknown
): Promise<number> {
  await mkdir(dirname(file), { recursive: true });
  const lines = await readJsonlLines(file);
  const offset = lines.length + 1;
  await appendFile(file, `${JSON.stringify(createPayload(offset))}\n`, "utf8");
  return offset;
}

async function readJsonlEntries<T>(
  file: string,
  parseLine: (line: string, file: string) => T
): Promise<T[]> {
  const lines = await readJsonlLines(file);
  return lines.map((line) => parseLine(line, file));
}

async function readJsonlLines(file: string): Promise<string[]> {
  try {
    const content = await readFile(file, "utf8");
    return content.length === 0
      ? []
      : content.split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
