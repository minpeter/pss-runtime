import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { computeFileHash } from "./hashline";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";

const inputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    expected_file_hash: z.string().length(8).optional(),
  })
  .strict();

async function assertExpectedHash(
  path: string,
  expectedHash: string | undefined
): Promise<void> {
  if (expectedHash === undefined) {
    return;
  }
  const current = await readFile(path, "utf8");
  const currentHash = computeFileHash(current);
  if (currentHash !== expectedHash) {
    throw new Error(
      `Stale file hash ${expectedHash}; current hash is ${currentHash}.`
    );
  }
}

async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await lstat(path)).mode;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function atomicWrite(
  path: string,
  content: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await existingMode(path);
  const temporaryPath = `${path}.pss-${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  if (mode !== undefined) {
    await chmod(temporaryPath, mode);
  }
  await rename(temporaryPath, path);
}

export function createWriteFileTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Create or replace a UTF-8 file atomically. Prefer edit_file for surgical changes. Pass expected_file_hash when overwriting a file you read.",
    inputSchema,
    execute: async ({ path, content, expected_file_hash: expectedHash }) => {
      const absolutePath = await resolveWorkspacePath(workspace, path);
      await assertExpectedHash(absolutePath, expectedHash);
      await atomicWrite(absolutePath, content);
      return [
        "OK - wrote file",
        `path: ${workspaceRelativePath(workspace, absolutePath)}`,
        `bytes: ${Buffer.byteLength(content)}`,
        `file_hash: ${computeFileHash(content)}`,
      ].join("\n");
    },
  });
}
