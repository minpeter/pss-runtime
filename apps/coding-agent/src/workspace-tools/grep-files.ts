import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { formatLineAnchor } from "./hashline";
import { truncateToolOutput } from "./output";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";
import { globPatternToRegExp, walkWorkspaceFiles } from "./walk";

const END_OF_LINE_PATTERN = /\r?\n/u;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const inputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    include: z.string().min(1).optional(),
    fixed_strings: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    include_ignored: z.boolean().optional(),
    max_results: z.number().int().positive().max(1000).optional(),
  })
  .strict();

function createMatcher(
  pattern: string,
  fixedStrings: boolean,
  caseSensitive: boolean
): (line: string) => boolean {
  if (fixedStrings) {
    const expected = caseSensitive ? pattern : pattern.toLocaleLowerCase();
    return (line) =>
      (caseSensitive ? line : line.toLocaleLowerCase()).includes(expected);
  }
  const expression = new RegExp(pattern, caseSensitive ? "u" : "iu");
  return (line) => expression.test(line);
}

async function searchFile(
  file: string,
  relativePath: string,
  matchesLine: (line: string) => boolean
): Promise<readonly string[]> {
  if ((await stat(file)).size > MAX_FILE_BYTES) {
    return [];
  }
  const content = await readFile(file);
  if (content.includes(0)) {
    return [];
  }
  const results: string[] = [];
  for (const [index, line] of content
    .toString("utf8")
    .split(END_OF_LINE_PATTERN)
    .entries()) {
    if (matchesLine(line)) {
      const clipped = line.length > 500 ? `${line.slice(0, 500)}…` : line;
      results.push(
        `${relativePath}:${formatLineAnchor(index + 1, line)}|${clipped}`
      );
    }
  }
  return results;
}

export function createGrepFilesTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Search text files and return path:LINE#ID|content matches compatible with plugsuits hashline anchors. Narrow path/include when output truncates.",
    inputSchema,
    execute: async ({
      pattern,
      path = ".",
      include,
      fixed_strings: fixedStrings = false,
      case_sensitive: caseSensitive = true,
      include_ignored: includeIgnored = false,
      max_results: maxResults = 200,
    }) => {
      const startPath = await resolveWorkspacePath(workspace, path);
      if (!(await stat(startPath)).isDirectory()) {
        throw new Error(`Grep path is not a directory: ${path}`);
      }
      const includeMatcher = include ? globPatternToRegExp(include) : undefined;
      const matchesLine = createMatcher(pattern, fixedStrings, caseSensitive);
      const results: string[] = [];
      const files = await walkWorkspaceFiles(
        workspace,
        startPath,
        includeIgnored
      );
      for (const file of files) {
        const relativePath = workspaceRelativePath(workspace, file);
        if (
          includeMatcher &&
          !includeMatcher.test(relativePath) &&
          !includeMatcher.test(basename(relativePath))
        ) {
          continue;
        }
        results.push(...(await searchFile(file, relativePath, matchesLine)));
        if (results.length >= maxResults) {
          const truncated = results.slice(0, maxResults);
          return truncateToolOutput(
            `OK - ${truncated.length}+ match(es), truncated\n${truncated.join("\n")}`
          );
        }
      }
      return truncateToolOutput(
        `OK - ${results.length} match(es)\n${results.join("\n")}`
      );
    },
  });
}
