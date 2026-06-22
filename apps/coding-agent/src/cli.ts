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

  if (command === "inspect-thread") {
    const config = resolveCodingAgentThreadConfig(env, cwd, home);
    const report = await inspectCodingAgentThread(config);
    stdout.write(`${formatThreadInspectionReport(report)}\n`);
    return 0;
  }

  throw new Error(`Unknown pss command: ${command}`);
}
