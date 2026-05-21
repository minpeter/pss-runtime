import { homedir } from "node:os";
import { join } from "node:path";

interface SessionConfigEnv {
  readonly PSS_SESSION_DIR?: string;
  readonly PSS_SESSION_KEY?: string;
}

export interface CodingAgentSessionConfig {
  readonly directory: string;
  readonly key: string;
}

export function resolveCodingAgentSessionConfig(
  env: SessionConfigEnv = process.env,
  cwd = process.cwd(),
  home = homedir()
): CodingAgentSessionConfig {
  return {
    directory: nonEmpty(env.PSS_SESSION_DIR) ?? join(home, ".pss", "sessions"),
    key: nonEmpty(env.PSS_SESSION_KEY) ?? `cwd:${cwd}`,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
