import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { CommitResult, SessionStore, StoredSession } from "./types";

interface StoredFileSession {
  state: unknown;
  version: string;
}

export class FileSessionStore implements SessionStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async load(key: string): Promise<StoredSession | null> {
    const file = this.#fileForKey(key);

    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      return parseStoredFileSession(parsed, file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new Error(
          `FileSessionStore failed to parse ${file}: ${error.message}`
        );
      }
      throw error;
    }
  }

  async commit(
    key: string,
    next: StoredSession,
    options?: { expectedVersion?: string }
  ): Promise<CommitResult> {
    const file = this.#fileForKey(key);
    await mkdir(dirname(file), { recursive: true });
    return await withFileLock(file, async () => {
      const current = await this.load(key);

      if (
        options?.expectedVersion !== undefined &&
        options.expectedVersion !== current?.version
      ) {
        return { ok: false, reason: "conflict" };
      }

      const version = String((Number(current?.version ?? "0") || 0) + 1);
      const payload: StoredFileSession = structuredClone({
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
    });
  }

  #fileForKey(key: string): string {
    return join(
      this.#directory,
      `${Buffer.from(key).toString("base64url")}.json`
    );
  }
}

function parseStoredFileSession(value: unknown, file: string): StoredSession {
  if (value === null || typeof value !== "object") {
    throw new Error(
      `FileSessionStore unsupported session file ${file}: expected object`
    );
  }

  const candidate = value as Partial<StoredFileSession>;
  if (typeof candidate.version !== "string" || !("state" in candidate)) {
    throw new Error(
      `FileSessionStore unsupported session file ${file}: missing version/state`
    );
  }

  return structuredClone({
    state: candidate.state,
    version: candidate.version,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function withFileLock<T>(
  file: string,
  task: () => Promise<T>
): Promise<T> {
  const lockDirectory = `${file}.lock`;
  await acquireFileLock(lockDirectory);
  try {
    return await task();
  } finally {
    await rm(lockDirectory, { force: true, recursive: true });
  }
}

async function acquireFileLock(lockDirectory: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await mkdir(lockDirectory);
      return;
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw error;
      }
    }

    await setTimeout(10);
  }

  throw new Error(
    `Timed out waiting for FileSessionStore lock ${lockDirectory}`
  );
}
