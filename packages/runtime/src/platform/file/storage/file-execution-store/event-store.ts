import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EventCursor,
  EventStore,
  StoredAgentEvent,
} from "../../../../execution/host/types";
import type { AgentEvent } from "../../../../thread/protocol/events";
import { parseEventLogLine } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey, isNodeError } from "./utils";

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
    return await this.#lock(async () => {
      const file = await this.#fileForRun(runId);
      await mkdir(dirname(file), { recursive: true });
      const offset = (await this.#countUnlocked(file)) + 1;
      await appendFile(
        file,
        `${JSON.stringify({ cursor: { offset }, event, runId })}\n`,
        "utf8"
      );
      return { offset };
    });
  }

  async *read(
    runId: string,
    cursor?: EventCursor
  ): AsyncIterable<StoredAgentEvent> {
    const events = await this.#lock(async () => {
      const file = await this.#fileForRun(runId);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const parsed: StoredAgentEvent[] = [];
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        parsed.push(parseEventLogLine(line, file));
      }
      return parsed;
    });

    const start = cursor?.offset ?? 0;
    for (const event of events.slice(start)) {
      yield structuredClone(event);
    }
  }

  async #countUnlocked(file: string): Promise<number> {
    try {
      const content = await readFile(file, "utf8");
      if (content.length === 0) {
        return 0;
      }
      return content.split("\n").filter((line) => line.length > 0).length;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async #fileForRun(runId: string): Promise<string> {
    return join(await this.#directory(), "events", `${encodeKey(runId)}.jsonl`);
  }
}
