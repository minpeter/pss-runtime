import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isScheduledThreadPrompt } from "../../../execution/scheduled-work";
import type {
  ScheduledWorkKind,
  StoredScheduledRunWork,
  StoredScheduledThreadPromptWork,
  StoredScheduledWork,
} from "./scheduled-work-types";

export function parseStoredScheduledRunWork(
  value: unknown,
  file: string
): StoredScheduledRunWork {
  const record = parseStoredScheduledWork(value, file);
  if (typeof record.payload !== "string") {
    throw invalidScheduledWorkFile(file, "expected run payload");
  }
  return {
    createdAt: record.createdAt,
    dueAt: record.dueAt,
    payload: record.payload,
    workId: record.workId,
  };
}

export function parseStoredScheduledThreadPromptWork(
  value: unknown,
  file: string
): StoredScheduledThreadPromptWork {
  const record = parseStoredScheduledWork(value, file);
  if (!isScheduledThreadPrompt(record.payload)) {
    throw invalidScheduledWorkFile(file, "expected thread prompt payload");
  }
  return {
    createdAt: record.createdAt,
    dueAt: record.dueAt,
    payload: record.payload,
    workId: record.workId,
  };
}

function parseStoredScheduledWork(
  value: unknown,
  file: string
): StoredScheduledWork<unknown> {
  if (
    !isRecord(value) ||
    typeof value.createdAt !== "number" ||
    (value.dueAt !== undefined && typeof value.dueAt !== "number") ||
    !("payload" in value) ||
    typeof value.workId !== "string"
  ) {
    throw invalidScheduledWorkFile(file, "expected scheduled work object");
  }
  return {
    createdAt: value.createdAt,
    dueAt: value.dueAt ?? value.createdAt,
    payload: value.payload,
    workId: value.workId,
  };
}

export function decrementLimit(limit: { value: number | undefined }): void {
  if (limit.value !== undefined) {
    limit.value = Math.max(0, limit.value - 1);
  }
}

function invalidScheduledWorkFile(file: string, message: string): Error {
  return new Error(
    `Invalid Node scheduled work file ${JSON.stringify(file)}: ${message}`
  );
}

export async function readJsonFile<T>(
  file: string,
  parse: (value: unknown, file: string) => T,
  label: string
): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parse(parsed, file);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid Node ${label} ${JSON.stringify(file)}: invalid JSON (${
          error.message
        })`
      );
    }
    throw error;
  }
}

export async function writeJsonFileIfAbsent(
  file: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

export function fileForScheduledWork(
  directory: string,
  kind: ScheduledWorkKind,
  workId: string
): string {
  return join(
    directory,
    "scheduled-work",
    kind,
    `${Buffer.from(workId).toString("base64url")}.json`
  );
}

import { isNodeError, isPlainRecord as isRecord } from "../../../internal/guards";
