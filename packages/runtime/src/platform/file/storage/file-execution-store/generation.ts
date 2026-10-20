import { randomUUID } from "node:crypto";
import { type Dirent, readFileSync } from "node:fs";
import {
  copyFile,
  cp,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../../../internal/guards";

const DATA_DIRECTORIES = [
  "checkpoints",
  "events",
  "inputs",
  "notifications",
  "runs",
  "scheduled-work",
  "thread-events",
  "threads",
] as const;

const CURRENT_GENERATION_FILE = ".current-generation";
export const GENERATIONS_DIRECTORY = "generations";
export const INITIAL_GENERATION_ID = "main";

/** Directory-fsync errors from platforms or filesystems that cannot sync one. */
const UNSUPPORTED_DIRECTORY_SYNC: Partial<Record<string, true>> = {
  EINVAL: true,
  EISDIR: true,
  ENOTSUP: true,
};

/**
 * Builds `target` from `source` by hard-linking every file, copying only where
 * the filesystem refuses a link. Store writers never modify an inode that has
 * other links (they rename a fresh file over it, and `appendJsonLine` copies a
 * shared log first), so `target` can diverge without changing `source`.
 */
export async function linkDataDirectories(
  source: string,
  target: string
): Promise<void> {
  await Promise.all(
    DATA_DIRECTORIES.map((dataDirectory) =>
      linkTree(join(source, dataDirectory), join(target, dataDirectory))
    )
  );
}

export async function currentDataDirectory(directory: string): Promise<string> {
  const generationId = await currentGenerationId(directory);
  return join(directory, GENERATIONS_DIRECTORY, generationId);
}

export async function migrateLegacyScheduledWork(
  directory: string,
  target: string
): Promise<void> {
  const source = join(directory, "scheduled-work");
  try {
    await cp(source, join(target, "scheduled-work"), { recursive: true });
    await rm(source, { force: true, recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** The generation named by the pointer, without creating the initial one. */
export async function readCurrentGenerationId(
  directory: string
): Promise<string | null> {
  try {
    const generationId = (
      await readFile(join(directory, CURRENT_GENERATION_FILE), "utf8")
    ).trim();
    return generationId.length > 0 ? generationId : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** The generation named by the pointer, or the initial one, read synchronously. */
export function currentGenerationIdSync(directory: string): string {
  try {
    const generationId = readFileSync(
      join(directory, CURRENT_GENERATION_FILE),
      "utf8"
    ).trim();
    return generationId.length > 0 ? generationId : INITIAL_GENERATION_ID;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return INITIAL_GENERATION_ID;
    }
    throw error;
  }
}

async function currentGenerationId(directory: string): Promise<string> {
  const generationId = await readCurrentGenerationId(directory);
  if (generationId) {
    return generationId;
  }

  await writeCurrentGeneration(directory, INITIAL_GENERATION_ID);
  return INITIAL_GENERATION_ID;
}

/**
 * Durably points the store at `generationId`. Before the pointer rename, one
 * parallel flush covers what the generation does not share with a committed
 * one (single-link files, i.e. written or copied rather than linked, and every
 * directory's entries), its entry under `generations/`, and the new pointer
 * contents; the store directory is flushed after the rename.
 */
export async function writeCurrentGeneration(
  directory: string,
  generationId: string
): Promise<void> {
  const generations = join(directory, GENERATIONS_DIRECTORY);
  const generation = join(generations, generationId);
  await mkdir(generation, { recursive: true });
  const file = join(directory, CURRENT_GENERATION_FILE);
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${generationId}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    const files = [tempFile];
    const directories = [generations];
    await collectUnshared(generation, files, directories);
    await Promise.all([
      ...files.map(syncFile),
      ...directories.map(syncDirectory),
    ]);
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

async function collectUnshared(
  directory: string,
  files: string[],
  directories: string[]
): Promise<void> {
  directories.push(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectUnshared(path, files, directories);
      } else if (entry.isFile() && (await lstat(path)).nlink === 1) {
        files.push(path);
      }
    })
  );
}

/**
 * Removes every generation except `currentGenerationId`. Callers hold the
 * store lock and have already published `currentGenerationId`: every reader
 * resolves the pointer under that lock and no other transaction can be
 * building, so nothing removed here is still reachable.
 */
export async function pruneGenerations(
  directory: string,
  currentGenerationId: string
): Promise<void> {
  const generations = join(directory, GENERATIONS_DIRECTORY);
  const entries = await readdir(generations);
  await Promise.all(
    entries
      .filter((entry) => entry !== currentGenerationId)
      .map((entry) =>
        rm(join(generations, entry), { force: true, recursive: true })
      )
  );
}

async function linkTree(source: string, target: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await mkdir(target, { recursive: true });
  await Promise.all(
    entries.map(async (entry) => {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isDirectory()) {
        await linkTree(from, to);
        return;
      }
      try {
        await link(from, to);
      } catch {
        // EXDEV, EPERM, EMLINK, or no hard links on this filesystem.
        await copyFile(from, to);
      }
    })
  );
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !(
        isNodeError(error) &&
        UNSUPPORTED_DIRECTORY_SYNC[error.code ?? ""] === true
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
