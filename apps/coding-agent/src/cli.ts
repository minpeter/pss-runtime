import { homedir } from "node:os";
import { resolveCodingAgentThreadConfig } from "./thread-config";
import {
  formatThreadInspectionReport,
  inspectCodingAgentThread,
} from "./thread-inspect";
import { startTui } from "./tui";

interface CliWritable {
  write(text: string): void;
}

interface RunCodingAgentCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Parameters<typeof resolveCodingAgentThreadConfig>[0];
  readonly home?: string;
  readonly start?: () => Promise<void>;
  readonly stdout?: CliWritable;
}

export async function runCodingAgentCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  start = startTui,
  stdout = process.stdout,
}: RunCodingAgentCliOptions = {}): Promise<number> {
  const command = argv[0];

  if (command === undefined) {
    await start();
    return 0;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  if (command === "inspect-thread") {
    const config = resolveCodingAgentThreadConfig(env, cwd, home);
    const report = await inspectCodingAgentThread(config);
    stdout.write(`${formatThreadInspectionReport(report)}\n`);
    return 0;
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
    "  inspect-thread   Print a report for the configured thread",
    "  help             Show this help message",
  ].join("\n");
}
