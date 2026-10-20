import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "../../../../internal/guards";

export async function readJsonFile<T>(
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

export async function writeJsonFile(
  file: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await replaceFile(file, (tempFile) =>
    writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  );
}

/**
 * Appends one JSON line. Transaction generations hard-link unchanged files, so
 * a file with other links is copied, appended, and renamed into place instead:
 * the inode the committed generation still names never changes.
 */
export async function appendJsonLine(
  file: string,
  value: unknown
): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (!(await hasOtherLinks(file))) {
    await appendFile(file, line, "utf8");
    return;
  }
  await replaceFile(file, async (tempFile) => {
    await copyFile(file, tempFile);
    await appendFile(tempFile, line, "utf8");
  });
}

async function hasOtherLinks(file: string): Promise<boolean> {
  try {
    return (await stat(file)).nlink > 1;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Writes a fresh inode via `write(tempFile)` and renames it over `file`. */
async function replaceFile(
  file: string,
  write: (tempFile: string) => Promise<void>
): Promise<void> {
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await write(tempFile);
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
