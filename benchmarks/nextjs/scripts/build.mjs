import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const checkedFiles = [
  "scripts/score.mjs",
  "src/pss-agent.mjs",
  "src/run-benchmark.mjs",
  "src/sandbox-runner.mjs",
  "src/scoring.mjs",
];

for (const file of checkedFiles) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `${file} failed syntax check`
    );
  }
}
await mkdir(resolve("dist"), { recursive: true });
await writeFile(
  resolve("dist/build.json"),
  `${JSON.stringify({ checkedFiles }, null, 2)}\n`,
  "utf8"
);
