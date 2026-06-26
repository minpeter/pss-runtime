import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

let loaded = false;

export function loadWorkerAgentEvalEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;

  const varsPath = resolve(import.meta.dirname, "../../.dev.vars");
  if (existsSync(varsPath)) {
    loadEnvFile(varsPath);
  }
}
