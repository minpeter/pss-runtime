import { spawn } from "node:child_process";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { truncateToolOutput } from "./output";

const inputSchema = z
  .object({
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(600).optional(),
  })
  .strict();

interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 2_000_000 ? next : next.slice(-2_000_000);
}

function runCommand(
  workspace: string,
  command: string,
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: workspace,
      detached: true,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stderr, stdout, timedOut });
    });
  });
}

export function createShellExecuteTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Execute a non-interactive shell command in the workspace. Use read_file/glob_files/grep_files for inspection and edit_file/write_file for mutations. Run tests and builds after changes.",
    inputSchema,
    execute: async ({ command, timeout_seconds: timeoutSeconds = 120 }) => {
      const result = await runCommand(
        workspace,
        command,
        timeoutSeconds * 1000
      );
      return truncateToolOutput(
        [
          result.timedOut
            ? "ERROR - command timed out"
            : "OK - command finished",
          `exit_code: ${result.exitCode ?? "null"}`,
          `signal: ${result.signal ?? "none"}`,
          "stdout:",
          result.stdout,
          "stderr:",
          result.stderr,
        ].join("\n")
      );
    },
  });
}
