#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const distRoot = "packages/runtime/dist";
const rawNames = [
  "LanguageModel",
  "ToolSet",
  "ModelMessage",
  "AssistantModelMessage",
  "ToolModelMessage",
];
const allowedFiles = new Set([
  "agent.d.ts",
  "agent-loop.d.ts",
  "llm.d.ts",
  "session/history.d.ts",
  "session/mapping.d.ts",
  "test-fixtures.d.ts",
  "src/agent.d.ts",
  "src/agent-loop.d.ts",
  "src/env.d.ts",
  "src/llm.d.ts",
  "src/session/history.d.ts",
  "src/session/mapping.d.ts",
]);
const allowedAliasNames = [
  "AgentModel",
  "AgentTools",
  "RuntimeLlm",
  "RuntimeLlmContext",
  "RuntimeLlmOutput",
  "RuntimeCreateLlmOptions",
];

const violations = [];
for (const file of collectDeclarationFiles(distRoot)) {
  const text = readFileSync(file, "utf8");

  if (file === "packages/runtime/dist/index.d.ts") {
    for (const rawName of rawNames) {
      if (text.includes(rawName)) {
        violations.push(
          `${file}: root declaration exposes raw AI SDK name ${rawName}`
        );
      }
    }
    continue;
  }

  const relative = file.slice(distRoot.length + 1);
  if (!allowedFiles.has(relative)) {
    for (const rawName of rawNames) {
      if (text.includes(rawName)) {
        violations.push(
          `${relative}: unauthorized raw AI SDK name ${rawName} in ${file}`
        );
      }
    }
  }
}

const indexText = readFileSync("packages/runtime/dist/index.d.ts", "utf8");
for (const aliasName of allowedAliasNames) {
  if (!indexText.includes(aliasName)) {
    violations.push(
      `packages/runtime/dist/index.d.ts: missing explicit interop alias ${aliasName}`
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

function collectDeclarationFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectDeclarationFiles(path));
    } else if (stat.isFile() && path.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}
