import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  resolveJudgeRuntime,
  runWithDefinition,
} from "@vercel/agent-eval/orchestrator";
import { createPssAgent } from "../src/pss-agent.mjs";
import { runAgent } from "../src/sandbox-runner.mjs";

const metadataPattern = /metadata/u;
const tarballPattern = /pss-coding-agent\.tgz/u;

let temporaryDirectory;
let originalPath;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "pss-adapter-"));
  originalPath = process.env.PATH;
  const executable = join(temporaryDirectory, "pss");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const resultIndex = process.argv.indexOf("--result-file");
const resultPath = process.argv[resultIndex + 1];
fs.writeFileSync(resultPath, JSON.stringify({
  status: "completed",
  finalText: "done",
  modelIds: ["observed-qwen"],
}));
process.stdout.write(JSON.stringify({ type: "metadata" }) + "\\n");
`,
    "utf8"
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${temporaryDirectory}:${originalPath ?? ""}`;
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("PSS definition exposes deterministic install and auth settings", () => {
  const agent = createPssAgent();
  assert.equal(agent.name, "pss");
  assert.equal(agent.getDefaultModel(), "qwen3.8-max-preview");
  assert.deepEqual(
    agent.definition.authEnv({
      apiKey: "secret",
      agentOptions: { baseUrl: "https://gateway.example/v1" },
    }),
    {
      AI_API_KEY: "secret",
      AI_BASE_URL: "https://gateway.example/v1",
      PSS_DISABLE_UPDATE_CHECK: "1",
    }
  );
  assert.equal(
    agent.definition.runnerExtra({ timeout: 5000 }).timeoutSeconds,
    5
  );
  assert.match(agent.definition.install()[1].args.join(" "), tarballPattern);
});

test("PSS adapter preserves the exported orchestrator's pre-abort result", async () => {
  const agent = createPssAgent();
  const options = {
    apiKey: "secret",
    model: "requested-qwen",
    prompt: "Do not run",
    signal: AbortSignal.abort(),
    timeout: 5000,
    webResearch: false,
  };
  // The real orchestrator must return before fixture access or sandbox creation.
  const direct = await runWithDefinition(agent.definition, "", options);
  assert.deepEqual(direct, {
    success: false,
    output: "",
    error: "Aborted before start",
    duration: 0,
  });
  assert.deepEqual(await agent.run("", options), direct);
});

test("v2 self-judge keeps PSS auth, model and runner timeout separate", () => {
  const agent = createPssAgent();
  const options = {
    apiKey: "secret",
    agentOptions: { baseUrl: "https://gateway.example/v1" },
    model: "requested-qwen",
    prompt: "Do not run",
    timeout: 5000,
    webResearch: false,
  };
  const runtime = resolveJudgeRuntime(agent.definition, options);
  assert.equal(runtime.isSelf, true);
  assert.equal(runtime.judgeDef, agent.definition);
  assert.equal(runtime.runnerSource, null);
  assert.deepEqual(runtime.authEnv, agent.definition.authEnv(options));
  assert.equal(runtime.config.model, options.model);
  assert.deepEqual(runtime.config.extra, { timeoutSeconds: 5 });
  assert.equal(JSON.stringify(runtime.config).includes(options.apiKey), false);
});

test("sandbox runner invokes pss exec and returns its observed model", () => {
  const result = runAgent({
    cwd: temporaryDirectory,
    extra: { timeoutSeconds: 10 },
    model: "requested-qwen",
    prompt: "Change the fixture",
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "done");
  assert.equal(result.observedModel, "observed-qwen");
  assert.match(result.transcript, metadataPattern);
  assert.equal(result.agentExitCode, 0);
});
