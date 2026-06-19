import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface NodeScheduledThreadPrompt {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
}

export interface NodeScheduledWorkListOptions {
  readonly limit?: number;
}

type ScheduledWorkKind = "run" | "thread-prompt";

interface StoredScheduledWork<T> {
  readonly createdAt: number;
  readonly payload: T;
  readonly workId: string;
}

type StoredScheduledRunWork = StoredScheduledWork<string>;
type StoredScheduledThreadPromptWork =
  StoredScheduledWork<NodeScheduledThreadPrompt>;

export async function appendScheduledNodeRun(
  directory: string,
  runId: string
): Promise<void> {
  await insertScheduledWork(directory, "run", runId, runId);
}

export async function appendScheduledNodeThreadPrompt(
  directory: string,
  prompt: NodeScheduledThreadPrompt
): Promise<void> {
  await insertScheduledWork(
    directory,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt),
    prompt
  );
}

export async function listScheduledNodeRuns(
  directory: string,
  options: NodeScheduledWorkListOptions = {}
): Promise<readonly string[]> {
  const rows = await selectScheduledRunWork(directory, options);
  return rows.map((row) => row.payload);
}

export async function ackScheduledNodeRun(
  directory: string,
  runId: string
): Promise<void> {
  await deleteScheduledWork(directory, "run", runId);
}

export async function listScheduledNodeThreadPrompts(
  directory: string,
  options: NodeScheduledWorkListOptions = {}
): Promise<readonly NodeScheduledThreadPrompt[]> {
  const rows = await selectScheduledThreadPromptWork(directory, options);
  return rows.map((row) => row.payload);
}

export async function ackScheduledNodeThreadPrompt(
  directory: string,
  prompt: NodeScheduledThreadPrompt
): Promise<void> {
  await deleteScheduledWork(
    directory,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
}

async function insertScheduledWork<T>(
  directory: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: T
): Promise<void> {
  const file = fileForScheduledWork(directory, kind, workId);
  try {
    await readFile(file, "utf8");
    return;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  await writeJsonFileIfAbsent(file, {
    createdAt: Date.now(),
    payload,
    workId,
  } satisfies StoredScheduledWork<T>);
}

async function selectScheduledRunWork(
  directory: string,
  options: NodeScheduledWorkListOptions
): Promise<readonly StoredScheduledRunWork[]> {
  return await selectScheduledWork(
    directory,
    "run",
    options,
    parseStoredScheduledRunWork
  );
}

async function selectScheduledThreadPromptWork(
  directory: string,
  options: NodeScheduledWorkListOptions
): Promise<readonly StoredScheduledThreadPromptWork[]> {
  return await selectScheduledWork(
    directory,
    "thread-prompt",
    options,
    parseStoredScheduledThreadPromptWork
  );
}

async function selectScheduledWork<T>(
  directory: string,
  kind: ScheduledWorkKind,
  options: NodeScheduledWorkListOptions,
  parse: (value: unknown, file: string) => StoredScheduledWork<T>
): Promise<readonly StoredScheduledWork<T>[]> {
  const workDirectory = join(directory, "scheduled-work", kind);
  let entries: readonly string[];
  try {
    entries = await readdir(workDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rows: StoredScheduledWork<T>[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    rows.push(
      await readJsonFile(
        join(workDirectory, entry),
        parse,
        "scheduled work file"
      )
    );
  }

  const limit = normalizedListLimit(options.limit);
  const sorted = rows.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.workId.localeCompare(right.workId)
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

async function deleteScheduledWork(
  directory: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<void> {
  await rm(fileForScheduledWork(directory, kind, workId), { force: true });
}

function parseStoredScheduledRunWork(
  value: unknown,
  file: string
): StoredScheduledRunWork {
  const record = parseStoredScheduledWork(value, file);
  if (typeof record.payload !== "string") {
    throw invalidScheduledWorkFile(file, "expected run payload");
  }
  return {
    createdAt: record.createdAt,
    payload: record.payload,
    workId: record.workId,
  };
}

function parseStoredScheduledThreadPromptWork(
  value: unknown,
  file: string
): StoredScheduledThreadPromptWork {
  const record = parseStoredScheduledWork(value, file);
  if (!isNodeScheduledThreadPrompt(record.payload)) {
    throw invalidScheduledWorkFile(file, "expected thread prompt payload");
  }
  return {
    createdAt: record.createdAt,
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
    !("payload" in value) ||
    typeof value.workId !== "string"
  ) {
    throw invalidScheduledWorkFile(file, "expected scheduled work object");
  }
  return {
    createdAt: value.createdAt,
    payload: value.payload,
    workId: value.workId,
  };
}

function isNodeScheduledThreadPrompt(
  value: unknown
): value is NodeScheduledThreadPrompt {
  return (
    isRecord(value) &&
    typeof value.threadKey === "string" &&
    (value.idempotencyKey === undefined ||
      typeof value.idempotencyKey === "string") &&
    (value.notificationId === undefined ||
      typeof value.notificationId === "string") &&
    (value.runId === undefined || typeof value.runId === "string")
  );
}

function invalidScheduledWorkFile(file: string, message: string): Error {
  return new Error(
    `Invalid Node scheduled work file ${JSON.stringify(file)}: ${message}`
  );
}

async function readJsonFile<T>(
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

async function writeJsonFileIfAbsent(
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

function fileForScheduledWork(
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

function threadPromptScheduledWorkId(
  prompt: NodeScheduledThreadPrompt
): string {
  return [prompt.threadKey, prompt.idempotencyKey ?? "", prompt.runId ?? ""]
    .map(scheduledWorkIdPart)
    .join("|");
}

function normalizedListLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}

function scheduledWorkIdPart(value: string): string {
  return `${value.length}:${value}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
