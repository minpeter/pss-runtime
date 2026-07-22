import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = resolve(current, "..");
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export async function resolveWorkspacePath(
  workspace: string,
  inputPath: string
): Promise<string> {
  const root = await realpath(resolve(workspace));
  const candidate = resolve(
    isAbsolute(inputPath) ? inputPath : resolve(root, inputPath)
  );
  if (!isInside(root, candidate)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  const existing = await nearestExistingPath(candidate);
  const resolvedExisting = await realpath(existing);
  if (!isInside(root, resolvedExisting)) {
    throw new Error(
      `Path resolves outside workspace through a symlink: ${inputPath}`
    );
  }
  return candidate;
}

export function workspaceRelativePath(workspace: string, path: string): string {
  const value = relative(resolve(workspace), path);
  return value === "" ? "." : value.split(sep).join("/");
}

export function isIgnoredWorkspacePath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment));
}
