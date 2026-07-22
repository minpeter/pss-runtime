import { lstat, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { computeFileHash } from "./hashline";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";

const inputSchema = z
  .object({
    path: z.string().min(1),
    recursive: z.boolean().optional(),
    expected_file_hash: z.string().length(8).optional(),
  })
  .strict();

export function createDeleteFileTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Delete a file or, with recursive=true, a directory. Prefer this over shell rm. Pass expected_file_hash for a file you read.",
    inputSchema,
    execute: async ({
      path,
      recursive = false,
      expected_file_hash: expectedHash,
    }) => {
      const absolutePath = await resolveWorkspacePath(workspace, path);
      if (absolutePath === resolve(workspace)) {
        throw new Error("Refusing to delete the workspace root.");
      }
      const metadata = await lstat(absolutePath);
      if (metadata.isDirectory() && !recursive) {
        throw new Error("Directory deletion requires recursive=true.");
      }
      if (expectedHash !== undefined) {
        if (!metadata.isFile()) {
          throw new Error("expected_file_hash is only valid for files.");
        }
        const currentHash = computeFileHash(
          await readFile(absolutePath, "utf8")
        );
        if (currentHash !== expectedHash) {
          throw new Error(
            `Stale file hash ${expectedHash}; current hash is ${currentHash}.`
          );
        }
      }
      await rm(absolutePath, { recursive, force: false });
      return `OK - deleted\npath: ${workspaceRelativePath(workspace, absolutePath)}`;
    },
  });
}
