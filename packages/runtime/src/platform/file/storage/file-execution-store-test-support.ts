import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Checkpoint,
  NotificationRecord,
  StoredAgentEvent,
  StoredThreadEvent,
  TurnRecord,
} from "../../../execution";

export const base64Url = (value: string) =>
  Buffer.from(value).toString("base64url");

export const malformedCheckpointPattern =
  /Invalid FileExecutionStore checkpoint file .*invalid JSON/;
export const malformedEventPattern =
  /Invalid FileExecutionStore event log .*invalid JSON/;
export const malformedNotificationPattern =
  /Invalid FileExecutionStore notification file .*invalid JSON/;
export const malformedRunPattern =
  /Invalid FileExecutionStore run file .*invalid JSON/;
export const malformedThreadPattern =
  /Invalid FileThreadStore file .*invalid JSON/;

export async function collectEvents(
  events: AsyncIterable<StoredAgentEvent>
): Promise<readonly StoredAgentEvent[]> {
  const collected: StoredAgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export async function collectThreadEvents(
  events: AsyncIterable<StoredThreadEvent>
): Promise<readonly StoredThreadEvent[]> {
  const collected: StoredThreadEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pss-runtime-file-execution-store-"));
}

export function contractTempDir(): string {
  return join(tmpdir(), randomUUID());
}

export async function currentDataDirectory(directory: string): Promise<string> {
  const generationId = await readFile(
    join(directory, ".current-generation"),
    "utf8"
  );
  return join(directory, "generations", generationId.trim());
}

export function createDeferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

export function runRecord(
  runId: string,
  overrides: Partial<TurnRecord> = {}
): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
    ...overrides,
  };
}

export function checkpointRecord(runId: string, version: number): Checkpoint {
  return {
    checkpointId: `${runId}:checkpoint-${version}`,
    phase: "before-model",
    runId,
    runtimeState: { version },
    threadSnapshot: { version },
    version,
  };
}

export function notificationRecord(
  idempotencyKey: string,
  overrides: Partial<NotificationRecord> = {}
): NotificationRecord {
  return {
    idempotencyKey,
    input: { text: "ready", type: "user-input" },
    notificationId: `${idempotencyKey}:notification`,
    runId: "run-1",
    threadKey: "thread-1",
    status: "pending",
    ...overrides,
  };
}
