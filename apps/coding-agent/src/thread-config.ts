import { homedir } from "node:os";
import { join } from "node:path";

interface ThreadConfigEnv {
  readonly PSS_SESSION_DIR?: string;
  readonly PSS_SESSION_KEY?: string;
  readonly PSS_THREAD_DIR?: string;
  readonly PSS_THREAD_KEY?: string;
}

export interface CodingAgentThreadConfig {
  readonly directory: string;
  readonly key: string;
}

export function resolveCodingAgentThreadConfig(
  env: ThreadConfigEnv = process.env,
  cwd = process.cwd(),
  home = homedir()
): CodingAgentThreadConfig {
  return {
    directory:
      nonEmpty(env.PSS_THREAD_DIR) ??
      nonEmpty(env.PSS_SESSION_DIR) ??
      join(home, ".pss", "threads"),
    key:
      nonEmpty(env.PSS_THREAD_KEY) ??
      nonEmpty(env.PSS_SESSION_KEY) ??
      `cwd:${cwd}`,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
