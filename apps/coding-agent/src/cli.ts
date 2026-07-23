import { homedir } from "node:os";
import { runExecCli } from "./exec-cli";
import { resolveCodingAgentThreadConfig } from "./thread-config";
import {
  formatThreadInspectionReport,
  inspectCodingAgentThread,
} from "./thread-inspect";
import { startTui } from "./tui/app";
import { cliVersion } from "./update/cli-version";
import { runUpdateCommand } from "./update/command";

interface RunCodingAgentCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Parameters<typeof resolveCodingAgentThreadConfig>[0];
  readonly exec?: (args: readonly string[]) => Promise<number>;
  readonly home?: string;
  readonly start?: () => Promise<number>;
  readonly stdout?: { write(text: string): void };
  readonly update?: (args: readonly string[]) => Promise<number>;
}

export async function runCodingAgentCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  exec,
  home = homedir(),
  start = startTui,
  stdout = process.stdout,
  update = (args: readonly string[]) =>
    runUpdateCommand({
      args,
      stdout,
      env,
      version: cliVersion,
      binPath: process.argv[1] ?? "",
      platform: process.platform,
    }),
}: RunCodingAgentCliOptions = {}): Promise<number> {
  const command = argv[0];

  if (command === undefined) {
    return start();
  }

  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  if (command === "exec") {
    return (
      exec ??
      ((args: readonly string[]) =>
        runExecCli({ argv: args, cwd, env, stdout }))
    )(argv.slice(1));
  }

  if (command === "inspect-thread") {
    const config = resolveCodingAgentThreadConfig(env, cwd, home);
    const report = await inspectCodingAgentThread(config);
    stdout.write(`${formatThreadInspectionReport(report)}\n`);
    return 0;
  }

  if (command === "update") {
    return update(argv.slice(1));
  }

  stdout.write(`Unknown pss command: ${command}\n\n${formatUsage()}\n`);
  return 1;
}

function formatUsage(): string {
  return [
    "Usage: pss [command]",
    "",
    "Commands:",
    "  (no command)     Start the interactive TUI",
    "  exec             Run one headless coding task",
    "  inspect-thread   Print a report for the configured thread",
    "  update           Update pss (--check, --channel <tag>)",
    "  help             Show this help message",
  ].join("\n");
}
