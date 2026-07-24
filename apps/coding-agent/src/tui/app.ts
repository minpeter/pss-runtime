import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentOptions } from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import type { ToolSet } from "ai";
import { createCodingAgent } from "../coding-agent";
import {
  formatModelEnvSetupHelp,
  isModelEnvValidationError,
  readOpenAICompatibleModelEnv,
} from "../env";
import { resolveCodingAgentThreadConfig } from "../thread-config";
import { planAutoUpdate, runAutoUpdate } from "../update/auto-update";
import { UPDATE_CHECK_CACHE_FILENAME } from "../update/check";
import { cliVersion } from "../update/cli-version";
import { emitUpdateNotice } from "../update/notifier";
import { type AgentTUIConfig, createAgentTUI } from "./agent";
import { createClearCommand } from "./command-set";
import { createToolRenderers } from "./renderers/tool-renderers";

export interface StartTuiOptions {
  /** Overrides the language model (tests and scripted QA). */
  readonly model?: AgentOptions["model"];
  /** Replaces the TUI's default optional OpenSearch tools. */
  readonly tools?: ToolSet;
}

const formatTokens = (n: number): string => {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
};

const resolveModelSubtitle = (): string | undefined => {
  try {
    return readOpenAICompatibleModelEnv({ runtimeEnv: process.env }).AI_MODEL;
  } catch {
    return;
  }
};

export async function startTui(options: StartTuiOptions = {}): Promise<number> {
  const startupNotices: string[] = [];
  const threadConfig = resolveCodingAgentThreadConfig();
  let agent: Awaited<ReturnType<typeof createCodingAgent>>;
  try {
    agent = await createCodingAgent({
      autoCompaction: threadConfig.autoCompaction,
      host: createFileHost({ directory: threadConfig.directory }),
      ...(options.model === undefined ? {} : { model: options.model }),
      tools: options.tools,
      webTools: {
        onWebToolsDisabled: (message) => startupNotices.push(message),
      },
      workspace: process.cwd(),
    });
  } catch (error) {
    if (isModelEnvValidationError(error)) {
      process.stderr.write(formatModelEnvSetupHelp(error));
      return 1;
    }
    throw error;
  }
  let thread = agent.thread(threadConfig.key);

  const noticeLines: string[] = [];
  const deferredRefreshes: (() => Promise<void>)[] = [];
  const updateNotice = await emitUpdateNotice({
    write: (line) => noticeLines.push(line),
    env: process.env,
    version: cliVersion,
    cachePath: join(homedir(), ".pss", UPDATE_CHECK_CACHE_FILENAME),
    schedule: (task) => deferredRefreshes.push(task),
  });
  const autoUpdate =
    cliVersion === undefined
      ? undefined
      : planAutoUpdate({
          notice: updateNotice,
          version: cliVersion,
          env: process.env,
          binPath: process.argv[1] ?? "",
        });
  if (autoUpdate !== undefined) {
    noticeLines.push(
      `auto-update enabled: pss ${autoUpdate.target} will be installed on exit`
    );
  }

  const footer: { text?: string } = {};
  const usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  const resetUsageTotals = (): void => {
    usageTotals.inputTokens = 0;
    usageTotals.outputTokens = 0;
    usageTotals.totalTokens = 0;
    footer.text = undefined;
  };

  const modelId = resolveModelSubtitle();
  const compactionText = `compaction auto max=${threadConfig.autoCompaction?.maxInputTokens ?? "default"}`;

  const tuiConfig: AgentTUIConfig = {
    thread: {
      interrupt: () => thread.interrupt(),
      send: (input) => thread.send(input),
      steer: (input) => thread.steer(input),
    },
    commands: [createClearCommand()],
    header: {
      title: "pss",
      subtitle: `${modelId ?? "unknown model"}\n${process.cwd()} · thread ${threadConfig.key} · ${compactionText}`,
    },
    footer,
    onModelUsage: (usage) => {
      usageTotals.inputTokens += usage.inputTokens ?? 0;
      usageTotals.outputTokens += usage.outputTokens ?? 0;
      usageTotals.totalTokens +=
        usage.totalTokens ??
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      footer.text = `${formatTokens(usageTotals.totalTokens)} tokens (${formatTokens(usageTotals.inputTokens)} in / ${formatTokens(usageTotals.outputTokens)} out)`;
    },
    onSetup: () => {
      for (const refresh of deferredRefreshes) {
        refresh().catch(() => undefined);
      }
    },
    onCommandAction: async (action) => {
      if (action.type !== "new-session") {
        return;
      }

      const previous = thread;
      previous.interrupt();
      await previous.delete();
      await previous.dispose();
      thread = agent.thread(threadConfig.key);
      resetUsageTotals();
    },
    setupMessages: [...startupNotices, ...noticeLines],
    toolRenderers: createToolRenderers(),
  };

  try {
    await createAgentTUI(tuiConfig);
  } finally {
    thread.interrupt();
    await thread.dispose().catch(() => undefined);
  }

  if (autoUpdate !== undefined) {
    return runAutoUpdate(autoUpdate, {
      platform: process.platform,
      stdout: process.stdout,
    });
  }
  return 0;
}

function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

if (isMainModule(import.meta.url)) {
  const exitCode = await startTui();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
