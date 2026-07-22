import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(benchmarkRoot, "../..");
const codingAgentDirectory = resolve(repositoryRoot, "apps/coding-agent");
const artifactsDirectory = resolve(benchmarkRoot, ".artifacts");
const stableTarball = resolve(artifactsDirectory, "pss-coding-agent.tgz");

// Read at runtime instead of a JSON module import: static imports crossing
// the package boundary fail the repo's turbo boundaries check.
const codingAgentPackage = JSON.parse(
  await readFile(resolve(codingAgentDirectory, "package.json"), "utf8")
);

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
}

await mkdir(artifactsDirectory, { recursive: true });
await Promise.all(
  (await readdir(artifactsDirectory))
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => rm(resolve(artifactsDirectory, entry), { force: true }))
);
run("pnpm", ["--filter", "@minpeter/pss-coding-agent", "build"]);
run(
  "pnpm",
  ["pack", "--pack-destination", artifactsDirectory],
  codingAgentDirectory
);
const tarballs = (await readdir(artifactsDirectory)).filter((entry) =>
  entry.endsWith(".tgz")
);
if (tarballs.length !== 1) {
  throw new Error(`Expected one PSS tarball, found ${tarballs.length}.`);
}
await rename(resolve(artifactsDirectory, tarballs[0]), stableTarball);
const content = await readFile(stableTarball);
const manifest = {
  package: codingAgentPackage.name,
  sha256: createHash("sha256").update(content).digest("hex"),
  version: codingAgentPackage.version,
};
await writeFile(
  resolve(artifactsDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
process.stdout.write(
  `Packed ${manifest.package}@${manifest.version} (${manifest.sha256.slice(0, 12)}).\n`
);
