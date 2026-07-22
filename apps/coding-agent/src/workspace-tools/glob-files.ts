import { stat } from "node:fs/promises";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";
import { globPatternToRegExp, walkWorkspaceFiles } from "./walk";

const inputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    include_ignored: z.boolean().optional(),
    max_results: z.number().int().positive().max(2000).optional(),
  })
  .strict();

export function createGlobFilesTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Find workspace files by glob pattern. Supports *, **, and ?. Defaults to excluding .git, node_modules, .next, dist, and coverage.",
    inputSchema,
    execute: async ({
      pattern,
      path = ".",
      include_ignored: includeIgnored = false,
      max_results: maxResults = 500,
    }) => {
      const startPath = await resolveWorkspacePath(workspace, path);
      if (!(await stat(startPath)).isDirectory()) {
        throw new Error(`Glob path is not a directory: ${path}`);
      }
      const matcher = globPatternToRegExp(pattern);
      const files = await walkWorkspaceFiles(
        workspace,
        startPath,
        includeIgnored
      );
      const matches = files
        .filter((file) => matcher.test(workspaceRelativePath(startPath, file)))
        .map((file) => workspaceRelativePath(workspace, file))
        .sort()
        .slice(0, maxResults);
      return truncateToolOutput(
        `OK - ${matches.length} file(s)\n${matches.join("\n")}`
      );
    },
  });
}
