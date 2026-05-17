import { existsSync, readFileSync } from "node:fs";

const dotenvLine = /^(?:export\s+)?(?<key>[\w.-]+)\s*=\s*(?<value>.*)$/;

export function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) {
    return;
  }

  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = dotenvLine.exec(trimmed);
    const key = match?.groups?.key;
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseEnvValue(match.groups?.value ?? "");
  }
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if (quote === '"' || quote === "'") {
    const end = trimmed.lastIndexOf(quote);
    const quoted = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
    return quote === '"' ? quoted.replaceAll("\\n", "\n") : quoted;
  }

  return trimmed.split("#", 1)[0]?.trimEnd() ?? "";
}
