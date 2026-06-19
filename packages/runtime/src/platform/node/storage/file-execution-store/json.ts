import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "./utils";

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
  const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
