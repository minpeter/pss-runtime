import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentOptions } from "@minpeter/pss-runtime";

interface ThreadConfigEnv {
  readonly PSS_AUTO_COMPACTION_MIN_MESSAGES?: string;
  readonly PSS_AUTO_COMPACTION_RETAIN_MESSAGES?: string;
  readonly PSS_THREAD_DIR?: string;
  readonly PSS_THREAD_KEY?: string;
}

export interface CodingAgentThreadConfig {
  readonly autoCompaction: AgentOptions["autoCompaction"];
  readonly directory: string;
  readonly key: string;
}

export function resolveCodingAgentThreadConfig(
  env: ThreadConfigEnv = process.env,
  cwd = process.cwd(),
  home = homedir()
): CodingAgentThreadConfig {
  return {
    autoCompaction: resolveAutoCompaction(env),
    directory: nonEmpty(env.PSS_THREAD_DIR) ?? join(home, ".pss", "threads"),
    key: nonEmpty(env.PSS_THREAD_KEY) ?? `cwd:${cwd}`,
  };
}

function resolveAutoCompaction(
  env: ThreadConfigEnv
): AgentOptions["autoCompaction"] {
  const minMessagesValue = nonEmpty(env.PSS_AUTO_COMPACTION_MIN_MESSAGES);
  const retainMessagesValue = nonEmpty(env.PSS_AUTO_COMPACTION_RETAIN_MESSAGES);

  if (minMessagesValue === undefined && retainMessagesValue === undefined) {
    return false;
  }

  if (minMessagesValue === undefined || retainMessagesValue === undefined) {
    throw new Error(
      "PSS_AUTO_COMPACTION_MIN_MESSAGES and PSS_AUTO_COMPACTION_RETAIN_MESSAGES must be set together."
    );
  }

  const minMessages = parsePositiveIntegerEnv(
    "PSS_AUTO_COMPACTION_MIN_MESSAGES",
    minMessagesValue
  );
  const retainMessages = parsePositiveIntegerEnv(
    "PSS_AUTO_COMPACTION_RETAIN_MESSAGES",
    retainMessagesValue
  );

  if (retainMessages >= minMessages) {
    throw new Error(
      "PSS_AUTO_COMPACTION_RETAIN_MESSAGES must be smaller than PSS_AUTO_COMPACTION_MIN_MESSAGES."
    );
  }

  return { minMessages, retainMessages };
}

function parsePositiveIntegerEnv(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
