import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "./types";

const LOCK_POLL_INTERVAL_MS = 10;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_TIMEOUT_MS = 5000;

export class FileThreadStore implements ThreadStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async load(key: string): Promise<StoredThread | null> {
    const file = this.#fileForKey(key);

    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      return parseStoredFileThread(parsed, file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new Error(
          `Invalid FileThreadStore file ${JSON.stringify(
            file
          )}: invalid JSON (${error.message})`
        );
      }
      throw error;
    }
  }

  async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const file = this.#fileForKey(key);
    const lockDirectory = `${file}.lock`;
    await mkdir(dirname(file), { recursive: true });
    await acquireFileLock(lockDirectory);
    try {
      const current = await this.load(key);
      const currentVersion = current?.version ?? null;

      if (options.expectedVersion !== currentVersion) {
        return { ok: false, reason: "conflict" };
      }

      const version = String((Number(current?.version ?? "0") || 0) + 1);
      const payload: StoredThread = structuredClone({
        state: next.state,
        version,
      });
      const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;

      try {
        await writeFile(
          tempFile,
          `${JSON.stringify(payload, null, 2)}\n`,
          "utf8"
        );
        await rename(tempFile, file);
      } catch (error) {
        await rm(tempFile, { force: true }).catch(() => undefined);
        throw error;
      }

      return { ok: true, version };
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.#fileForKey(key);
    const lockDirectory = `${file}.lock`;
    await mkdir(dirname(file), { recursive: true });
    await acquireFileLock(lockDirectory);
    try {
      await rm(file, { force: true });
    } finally {
      await rm(lockDirectory, { force: true, recursive: true });
    }
  }

  #fileForKey(key: string): string {
    return join(
      this.#directory,
      `${Buffer.from(key).toString("base64url")}.json`
    );
  }
}

function parseStoredFileThread(value: unknown, file: string): StoredThread {
  if (value === null || typeof value !== "object") {
    throw new Error(
      `Invalid FileThreadStore file ${JSON.stringify(file)}: expected an object`
    );
  }

  const candidate = value as Partial<StoredThread>;
  if (typeof candidate.version !== "string" || !("state" in candidate)) {
    throw new Error(
      `Invalid FileThreadStore file ${JSON.stringify(
        file
      )}: expected state and string version`
    );
  }

  return structuredClone({
    state: candidate.state,
    version: candidate.version,
  });
}

/** @deprecated Use FileThreadStore. */
export { FileThreadStore as FileSessionStore };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function acquireFileLock(lockDirectory: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
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
    `Timed out waiting for FileThreadStore lock ${JSON.stringify(
      lockDirectory
    )}`
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
