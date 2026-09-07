#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Timing wrapper for the fast local gates (VAL-LOCAL-024). Runs one gate
// command against its documented bound, measures wall-clock elapsed time,
// and on timeout kills the whole process group so no child survives.
//
// Usage: node scripts/time-gate.mjs --bound <seconds> --label <name> -- <cmd> [args...]
// Stdout: a single stable line, e.g.
//   GATE pre-commit: elapsed=3.2s bound=60s result=ok
// Exit 0 only when the gate exits 0 within its bound.

export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    return { error: "missing `--` before the gate command" };
  }
  const flags = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  if (command.length === 0) {
    return { error: "no gate command after `--`" };
  }
  let bound;
  let label;
  for (let index = 0; index < flags.length; index += 2) {
    const [flag, value] = flags.slice(index, index + 2);
    if (value === undefined) {
      return { error: `flag ${flag} has no value` };
    }
    if (flag === "--bound") {
      bound = Number(value);
      if (!Number.isFinite(bound) || bound <= 0) {
        return {
          error: `--bound must be a positive number of seconds, got "${value}"`,
        };
      }
    } else if (flag === "--label") {
      label = value;
    } else {
      return { error: `unknown flag ${flag}` };
    }
  }
  if (bound === undefined) {
    return { error: "missing --bound <seconds>" };
  }
  if (label === undefined) {
    return { error: "missing --label <name>" };
  }
  return { bound, label, command: command[0], args: command.slice(1) };
}

export function formatResult(label, elapsedSeconds, bound, result) {
  return `GATE ${label}: elapsed=${elapsedSeconds.toFixed(1)}s bound=${bound}s result=${result}`;
}

async function runGate({ bound, label, command, args }) {
  const started = performance.now();
  const child = spawn(command, args, {
    detached: true,
    stdio: "inherit",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // detached puts the gate in its own process group; a negative pid kills
    // the whole group, so grandchildren (e.g. lint-staged workers) cannot
    // survive the wrapper.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group already exited on its own.
    }
  }, bound * 1000);
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (exitCode, signal) => {
      resolve(exitCode ?? (signal === null ? 1 : 128));
    });
  });
  clearTimeout(timer);
  const elapsed = (performance.now() - started) / 1000;
  let result;
  if (timedOut) {
    result = "timeout";
  } else if (code !== 0) {
    result = `failed:${code}`;
  } else if (elapsed > bound) {
    result = "over-bound";
  } else {
    result = "ok";
  }
  process.stdout.write(`${formatResult(label, elapsed, bound, result)}\n`);
  process.exitCode = result === "ok" ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`time-gate: ${parsed.error}\n`);
    process.exitCode = 2;
  } else {
    await runGate(parsed);
  }
}
