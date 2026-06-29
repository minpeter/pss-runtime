#!/usr/bin/env node
import { runCodingAgentCli } from "../dist/cli.js";

try {
  const exitCode = await runCodingAgentCli();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
