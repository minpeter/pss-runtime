import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout } from "node:timers/promises";
import { isNodeError } from "../../../../internal/guards";
import type { FileExecutionLock } from "./types";

const LOCK_HEARTBEAT_INTERVAL_MS = 100;
const LOCK_POLL_INTERVAL_MS = 10;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_TIMEOUT_MS = 5000;

type LockMode = "auto" | "held";

export function createFileExecutionLock(
  lockDirectory: string,
  lockMode: LockMode
): FileExecutionLock {
  return async (fn) =>
    lockMode === "held"
      ? await fn()
      : await withFileLock(lockDirectory, "FileExecutionStore", fn);
}

export async function withFileLock<T>(
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
