import { randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout } from "node:timers/promises";
import type {
  CheckpointStore,
  CheckpointWriteResult,
  ClaimRunOptions,
  ClaimRunResult,
  CreateRunResult,
  EventCursor,
  EventStore,
  ExecutionStore,
  ExecutionStoreTransaction,
  NotificationClaimResult,
  NotificationInbox,
  NotificationRecord,
  NotificationWriteResult,
  RunCheckpoint,
  RunKind,
  RunLease,
  RunRecord,
  RunStatus,
  RunStore,
  StoredAgentEvent,
} from "../../../execution/host/types";
import type { AgentEvent, UserInput } from "../../../thread/protocol/events";
import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../../thread/store/types";
import { FileThreadStore } from "./file-thread-store";

const DATA_DIRECTORIES = [
  "checkpoints",
  "events",
  "notifications",
  "runs",
  "threads",
] as const;

const CURRENT_GENERATION_FILE = ".current-generation";
const GENERATIONS_DIRECTORY = "generations";
const INITIAL_GENERATION_ID = "main";
const LOCK_HEARTBEAT_INTERVAL_MS = 100;
const LOCK_POLL_INTERVAL_MS = 10;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_TIMEOUT_MS = 5000;

type LockMode = "auto" | "held";
type DataDirectoryResolver = () => Promise<string>;

export class FileExecutionStore implements ExecutionStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly notifications: NotificationInbox;
  readonly runs: RunStore;
  readonly threads: ThreadStore;

  readonly #directory: string;
  readonly #lockDirectory: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#lockDirectory = join(directory, ".execution.lock");
    const ports = createFileExecutionStorePorts(
      () => currentDataDirectory(directory),
      createFileExecutionLock(this.#lockDirectory, "auto")
    );

    this.runs = ports.runs;
    this.events = ports.events;
    this.checkpoints = ports.checkpoints;
    this.notifications = ports.notifications;
    this.threads = ports.threads;
  }

  get sessions(): ThreadStore {
    return this.threads;
  }

  async transaction<T>(
    fn: (tx: ExecutionStoreTransaction) => Promise<T>
  ): Promise<T> {
    return await withFileLock(
      this.#lockDirectory,
      "FileExecutionStore transaction",
      async () => {
        await mkdir(this.#directory, { recursive: true });
        const generationId = `transaction-${process.pid}-${randomUUID()}`;
        const transactionDirectory = join(
          this.#directory,
          GENERATIONS_DIRECTORY,
          generationId
        );
        await mkdir(transactionDirectory, { recursive: true });

        let committed = false;
        try {
          await copyDataDirectories(
            await currentDataDirectory(this.#directory),
            transactionDirectory
          );
          const tx = createFileExecutionStorePorts(
            () => Promise.resolve(transactionDirectory),
            createFileExecutionLock(this.#lockDirectory, "held")
          );
          const result = await fn(tx);
          await writeCurrentGeneration(this.#directory, generationId);
          committed = true;
          return result;
        } finally {
          if (!committed) {
            await rm(transactionDirectory, { force: true, recursive: true });
          }
        }
      }
    );
  }
}

function createFileExecutionStorePorts(
  directory: DataDirectoryResolver,
  lock: <T>(fn: () => Promise<T>) => Promise<T>
): ExecutionStoreTransaction {
  const runs = new FileRunStore(directory, lock);
  return {
    checkpoints: new FileCheckpointStore(directory, lock, runs),
    events: new FileEventStore(directory, lock),
    notifications: new FileNotificationInbox(directory, lock),
    runs,
    threads: new LockedThreadStore(
      async () => join(await directory(), "threads"),
      lock
    ),
  };
}

function createFileExecutionLock(
  lockDirectory: string,
  lockMode: LockMode
): <T>(fn: () => Promise<T>) => Promise<T> {
  return async (fn) =>
    lockMode === "held"
      ? await fn()
      : await withFileLock(lockDirectory, "FileExecutionStore", fn);
}

class LockedThreadStore implements ThreadStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    return await this.#lock(
      async () =>
        await new FileThreadStore(await this.#directory()).commit(
          key,
          next,
          options
        )
    );
  }

  async delete(key: string): Promise<void> {
    await this.#lock(async () => {
      await new FileThreadStore(await this.#directory()).delete(key);
    });
  }

  async load(key: string): Promise<StoredThread | null> {
    return await this.#lock(
      async () => await new FileThreadStore(await this.#directory()).load(key)
    );
  }
}

class FileRunStore implements RunStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async claim(
    runId: string,
    options: ClaimRunOptions
  ): Promise<ClaimRunResult> {
    return await this.#lock(async () => {
      const record = await this.#getUnlocked(runId);
      if (!record) {
        return { ok: false, reason: "not-found" };
      }

      if (!isClaimable(record)) {
        return { ok: false, reason: "not-claimable" };
      }

      if (
        record.lease &&
        record.lease.leaseUntilMs > options.nowMs &&
        record.status === "leased"
      ) {
        return { ok: false, reason: "leased" };
      }

      const lease: RunLease = {
        attempt: options.attempt,
        leaseId: options.leaseId,
        leaseUntilMs: options.nowMs + options.leaseMs,
      };
      const claimed: RunRecord = { ...record, lease, status: "leased" };
      await this.#writeUnlocked(claimed);
      return { lease, ok: true, record: claimed };
    });
  }

  async create(record: RunRecord): Promise<CreateRunResult> {
    return await this.#lock(async () => {
      const existingById = await this.#getUnlocked(record.runId);
      if (existingById) {
        return { ok: false, reason: "duplicate", record: existingById };
      }

      if (record.dedupeKey) {
        const existingByDedupeKey = await this.#getByDedupeKeyUnlocked(
          record.dedupeKey
        );
        if (existingByDedupeKey) {
          return {
            ok: false,
            reason: "duplicate",
            record: existingByDedupeKey,
          };
        }
      }

      await this.#writeUnlocked(record);
      return { ok: true, record };
    });
  }

  async get(runId: string): Promise<RunRecord | null> {
    return await this.#lock(async () => await this.#getUnlocked(runId));
  }

  async getByDedupeKey(dedupeKey: string): Promise<RunRecord | null> {
    return await this.#lock(
      async () => await this.#getByDedupeKeyUnlocked(dedupeKey)
    );
  }

  async listByParentRunId(parentRunId: string): Promise<readonly RunRecord[]> {
    return await this.#lock(async () => {
      const records = await this.#listUnlocked();
      return records.filter((record) => record.parentRunId === parentRunId);
    });
  }

  async update(record: RunRecord): Promise<RunRecord> {
    return await this.#lock(async () => {
      await this.#writeUnlocked(record);
      return record;
    });
  }

  async updateCheckpointVersion(
    runId: string,
    checkpointVersion: number
  ): Promise<void> {
    const record = await this.#getUnlocked(runId);
    if (!record) {
      return;
    }
    await this.#writeUnlocked({ ...record, checkpointVersion });
  }

  async #getByDedupeKeyUnlocked(dedupeKey: string): Promise<RunRecord | null> {
    const records = await this.#listUnlocked();
    return records.find((record) => record.dedupeKey === dedupeKey) ?? null;
  }

  async #getUnlocked(runId: string): Promise<RunRecord | null> {
    return await readJsonFile(
      await this.#fileForRun(runId),
      parseRunRecord,
      "run file"
    );
  }

  async #listUnlocked(): Promise<readonly RunRecord[]> {
    const directory = join(await this.#directory(), "runs");
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const record = await readJsonFile(
        join(directory, entry),
        parseRunRecord,
        "run file"
      );
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  async #writeUnlocked(record: RunRecord): Promise<void> {
    await writeJsonFile(await this.#fileForRun(record.runId), record);
  }

  async #fileForRun(runId: string): Promise<string> {
    return join(await this.#directory(), "runs", `${encodeKey(runId)}.json`);
  }
}

class FileEventStore implements EventStore {
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

class FileCheckpointStore implements CheckpointStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly #runs: FileRunStore;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>,
    runs: FileRunStore
  ) {
    this.#directory = directory;
    this.#lock = lock;
    this.#runs = runs;
  }

  async append(
    checkpoint: RunCheckpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    return await this.#lock(async () => {
      const current = await this.latestUnlocked(checkpoint.runId);
      const currentVersion = current?.version ?? 0;
      if (options.expectedVersion !== currentVersion) {
        return {
          currentVersion,
          ok: false,
          reason: "stale-version",
        };
      }

      await writeJsonFile(
        await this.#fileForCheckpoint(checkpoint.runId, checkpoint.version),
        checkpoint
      );
      await this.#runs.updateCheckpointVersion(
        checkpoint.runId,
        checkpoint.version
      );
      return { ok: true, version: checkpoint.version };
    });
  }

  async latest(runId: string): Promise<RunCheckpoint | null> {
    return await this.#lock(async () => await this.latestUnlocked(runId));
  }

  async latestUnlocked(runId: string): Promise<RunCheckpoint | null> {
    const directory = join(
      await this.#directory(),
      "checkpoints",
      encodeKey(runId)
    );
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const versions = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => Number(entry.slice(0, -".json".length)))
      .filter((version) => Number.isSafeInteger(version) && version > 0)
      .sort((left, right) => right - left);

    if (versions.length === 0) {
      return null;
    }

    return await readJsonFile(
      await this.#fileForCheckpoint(runId, versions[0]),
      parseRunCheckpoint,
      "checkpoint file"
    );
  }

  async #fileForCheckpoint(runId: string, version: number): Promise<string> {
    return join(
      await this.#directory(),
      "checkpoints",
      encodeKey(runId),
      `${version}.json`
    );
  }
}

class FileNotificationInbox implements NotificationInbox {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(idempotencyKey);
      if (!current) {
        return { ok: false, reason: "not-found" };
      }
      if (current.status !== "pending") {
        return {
          ok: false,
          reason: "already-claimed",
          record: current,
        };
      }
      const claimed: NotificationRecord = { ...current, status: "acked" };
      await this.#writeUnlocked(claimed);
      return { ok: true, record: claimed };
    });
  }

  async enqueue(record: NotificationRecord): Promise<NotificationWriteResult> {
    return await this.#lock(async () => {
      const existing = await this.#getUnlocked(record.idempotencyKey);
      if (existing) {
        return {
          existingNotificationId: existing.notificationId,
          ok: false,
          reason: "duplicate",
        };
      }
      await this.#writeUnlocked(record);
      return { ok: true };
    });
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    return await this.#lock(
      async () => await this.#getUnlocked(idempotencyKey)
    );
  }

  async releaseByIdempotencyKey(idempotencyKey: string): Promise<void> {
    await this.#lock(async () => {
      const current = await this.#getUnlocked(idempotencyKey);
      if (current?.status !== "acked") {
        return;
      }
      await this.#writeUnlocked({ ...current, status: "pending" });
    });
  }

  async #getUnlocked(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    return await readJsonFile(
      await this.#fileForIdempotencyKey(idempotencyKey),
      parseNotificationRecord,
      "notification file"
    );
  }

  async #writeUnlocked(record: NotificationRecord): Promise<void> {
    await writeJsonFile(
      await this.#fileForIdempotencyKey(record.idempotencyKey),
      record
    );
  }

  async #fileForIdempotencyKey(idempotencyKey: string): Promise<string> {
    return join(
      await this.#directory(),
      "notifications",
      `${encodeKey(idempotencyKey)}.json`
    );
  }
}

function parseRunRecord(value: unknown, file: string): RunRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected run object");
  }
  if (
    typeof value.checkpointVersion !== "number" ||
    !isRunKind(value.kind) ||
    typeof value.rootRunId !== "string" ||
    typeof value.runId !== "string" ||
    !isRunStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected run record fields");
  }

  return {
    checkpointVersion: value.checkpointVersion,
    ...(typeof value.dedupeKey === "string"
      ? { dedupeKey: value.dedupeKey }
      : {}),
    kind: value.kind,
    ...(isRunLease(value.lease) ? { lease: value.lease } : {}),
    ...("output" in value ? { output: value.output } : {}),
    ...(typeof value.ownerNamespace === "string"
      ? { ownerNamespace: value.ownerNamespace }
      : {}),
    ...(typeof value.parentRunId === "string"
      ? { parentRunId: value.parentRunId }
      : {}),
    ...(typeof value.publicTaskId === "string"
      ? { publicTaskId: value.publicTaskId }
      : {}),
    rootRunId: value.rootRunId,
    runId: value.runId,
    status: value.status,
    threadKey: value.threadKey,
  };
}

function parseRunCheckpoint(value: unknown, file: string): RunCheckpoint {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected checkpoint object");
  }
  if (
    typeof value.checkpointId !== "string" ||
    !isCheckpointPhase(value.phase) ||
    typeof value.runId !== "string" ||
    typeof value.version !== "number"
  ) {
    throw invalidFile(file, "expected checkpoint fields");
  }

  return {
    ...(typeof value.childRunId === "string"
      ? { childRunId: value.childRunId }
      : {}),
    checkpointId: value.checkpointId,
    ...("pendingToolCall" in value
      ? { pendingToolCall: value.pendingToolCall }
      : {}),
    phase: value.phase,
    runId: value.runId,
    runtimeState: value.runtimeState,
    threadSnapshot: value.threadSnapshot,
    version: value.version,
  };
}

function parseNotificationRecord(
  value: unknown,
  file: string
): NotificationRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected notification object");
  }
  if (
    typeof value.idempotencyKey !== "string" ||
    !isUserInput(value.input) ||
    typeof value.notificationId !== "string" ||
    typeof value.runId !== "string" ||
    !isNotificationStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected notification fields");
  }

  const observerEvents = Array.isArray(value.observerEvents)
    ? value.observerEvents.filter(isAgentEvent)
    : undefined;
  if (
    Array.isArray(value.observerEvents) &&
    observerEvents?.length !== value.observerEvents.length
  ) {
    throw invalidFile(file, "expected agent observer events");
  }

  return {
    idempotencyKey: value.idempotencyKey,
    input: value.input,
    notificationId: value.notificationId,
    ...(observerEvents ? { observerEvents } : {}),
    ...(typeof value.ownerNamespace === "string"
      ? { ownerNamespace: value.ownerNamespace }
      : {}),
    runId: value.runId,
    status: value.status,
    threadKey: value.threadKey,
  };
}

function parseEventLogLine(line: string, file: string): StoredAgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid FileExecutionStore event log ${JSON.stringify(
          file
        )}: invalid JSON (${error.message})`
      );
    }
    throw error;
  }

  if (
    !(isRecord(parsed) && isRecord(parsed.cursor)) ||
    typeof parsed.cursor.offset !== "number" ||
    !isAgentEvent(parsed.event) ||
    typeof parsed.runId !== "string"
  ) {
    throw invalidEventLog(file, "expected stored agent event");
  }

  return {
    cursor: { offset: parsed.cursor.offset },
    event: parsed.event,
    runId: parsed.runId,
  };
}

async function readJsonFile<T>(
  file: string,
  parse: (value: unknown, file: string) => T,
  label: string
): Promise<T | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parse(parsed, file);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid FileExecutionStore ${label} ${JSON.stringify(
          file
        )}: invalid JSON (${error.message})`
      );
    }
    throw error;
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyDataDirectories(
  source: string,
  target: string
): Promise<void> {
  for (const dataDirectory of DATA_DIRECTORIES) {
    const sourceDirectory = join(source, dataDirectory);
    const targetDirectory = join(target, dataDirectory);
    try {
      await cp(sourceDirectory, targetDirectory, { recursive: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

async function currentDataDirectory(directory: string): Promise<string> {
  const generationId = await currentGenerationId(directory);
  return join(directory, GENERATIONS_DIRECTORY, generationId);
}

async function currentGenerationId(directory: string): Promise<string> {
  const file = join(directory, CURRENT_GENERATION_FILE);
  try {
    const generationId = (await readFile(file, "utf8")).trim();
    if (generationId.length > 0) {
      return generationId;
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  await mkdir(join(directory, GENERATIONS_DIRECTORY, INITIAL_GENERATION_ID), {
    recursive: true,
  });
  await writeCurrentGeneration(directory, INITIAL_GENERATION_ID);
  return INITIAL_GENERATION_ID;
}

async function writeCurrentGeneration(
  directory: string,
  generationId: string
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, GENERATIONS_DIRECTORY, generationId), {
    recursive: true,
  });
  const file = join(directory, CURRENT_GENERATION_FILE);
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${generationId}\n`, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isClaimable(record: RunRecord): boolean {
  return (
    record.status === "leased" ||
    record.status === "needs-recovery" ||
    record.status === "queued" ||
    record.status === "running" ||
    record.status === "suspended"
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value.type === "string";
}

function isUserInput(value: unknown): value is UserInput {
  return (
    isRecord(value) &&
    ((value.type === "user-text" &&
      (typeof value.text === "string" || isStringArray(value.text))) ||
      (value.type === "user-message" && Array.isArray(value.content)))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRunLease(value: unknown): value is RunLease {
  return (
    isRecord(value) &&
    typeof value.attempt === "number" &&
    typeof value.leaseId === "string" &&
    typeof value.leaseUntilMs === "number"
  );
}

function isRunKind(value: unknown): value is RunKind {
  return (
    value === "notification" ||
    value === "tool-recovery" ||
    value === "user-turn"
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "cancelled" ||
    value === "completed" ||
    value === "error" ||
    value === "leased" ||
    value === "needs-recovery" ||
    value === "queued" ||
    value === "running" ||
    value === "suspended"
  );
}

function isCheckpointPhase(value: unknown): value is RunCheckpoint["phase"] {
  return (
    value === "after-model" ||
    value === "after-notification" ||
    value === "after-tool" ||
    value === "before-child-run" ||
    value === "before-model" ||
    value === "before-notification" ||
    value === "before-tool" ||
    value === "child-linked" ||
    value === "suspended"
  );
}

function isNotificationStatus(
  value: unknown
): value is NotificationRecord["status"] {
  return value === "acked" || value === "cancelled" || value === "pending";
}

function encodeKey(key: string): string {
  return Buffer.from(key).toString("base64url");
}

function invalidFile(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore file ${JSON.stringify(file)}: ${message}`
  );
}

function invalidEventLog(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore event log ${JSON.stringify(file)}: ${message}`
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function withFileLock<T>(
  lockDirectory: string,
  owner: string,
  fn: () => Promise<T>
): Promise<T> {
  await acquireFileLock(lockDirectory, owner);
  const heartbeat = setInterval(() => {
    refreshFileLock(lockDirectory).catch(() => undefined);
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await rm(lockDirectory, { force: true, recursive: true });
  }
}

async function acquireFileLock(
  lockDirectory: string,
  owner: string
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      await mkdir(dirname(lockDirectory), { recursive: true });
      await mkdir(lockDirectory);
      return;
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw error;
      }
      await removeStaleLock(lockDirectory);
    }

    await setTimeout(LOCK_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for ${owner} lock ${JSON.stringify(lockDirectory)}`
  );
}

async function removeStaleLock(lockDirectory: string): Promise<void> {
  try {
    const stats = await stat(lockDirectory);
    if (Date.now() - stats.mtimeMs < LOCK_STALE_AFTER_MS) {
      return;
    }
    await rm(lockDirectory, { force: true, recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function refreshFileLock(lockDirectory: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(lockDirectory, now, now);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
