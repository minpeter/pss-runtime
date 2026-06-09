import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const defaultDevVarsPath = resolve(import.meta.dirname, "../../.dev.vars");

export function loadDevVars(path = defaultDevVarsPath): Record<string, string> {
  const contents = readFileSync(path, "utf8");
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) {
      values[key] = value;
    }
  }
  return values;
}
