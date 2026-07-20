import { readFile, writeFile } from "node:fs/promises";

import {
  type SessionIndexRecord,
  SessionIndexRecordSchema,
  type SessionIndexRepository,
} from "./session-index";

export function createFileSessionIndexRepository(
  filePath: string
): SessionIndexRepository {
  let writeQueue: Promise<void> = Promise.resolve();

  const read = async (): Promise<Map<string, SessionIndexRecord>> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return new Map();
    }
    return parseRecords(raw);
  };

  const write = (records: Map<string, SessionIndexRecord>): Promise<void> => {
    const serialized = `${JSON.stringify([...records.values()], null, 2)}\n`;
    writeQueue = writeQueue.then(() => writeFile(filePath, serialized, "utf8"));
    return writeQueue;
  };

  return {
    all: async () => [...(await read()).values()],
    get: async (key) => (await read()).get(key),
    put: async (record) => {
      const records = await read();
      records.set(record.conversationKey, record);
      await write(records);
    },
  };
}

function parseRecords(raw: string): Map<string, SessionIndexRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) {
    return new Map();
  }
  const records = new Map<string, SessionIndexRecord>();
  for (const item of parsed) {
    const result = SessionIndexRecordSchema.safeParse(item);
    if (result.success) {
      records.set(result.data.conversationKey, result.data);
    }
  }
  return records;
}
