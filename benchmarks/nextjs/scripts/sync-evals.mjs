import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEXTJS_EVALS_REPOSITORY,
  NEXTJS_EVALS_SHA,
} from "../src/constants.mjs";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(benchmarkRoot, ".evals-checkout");
const destination = resolve(benchmarkRoot, "evals");

function git(args) {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `git ${args.join(" ")} failed`
    );
  }
}

await rm(checkout, { force: true, recursive: true });
await rm(destination, { force: true, recursive: true });
await mkdir(checkout, { recursive: true });
git(["init", "--quiet"]);
git(["remote", "add", "origin", NEXTJS_EVALS_REPOSITORY]);
git(["sparse-checkout", "init", "--cone"]);
git(["sparse-checkout", "set", "evals/evals"]);
git([
  "fetch",
  "--depth",
  "1",
  "--filter=blob:none",
  "origin",
  NEXTJS_EVALS_SHA,
]);
git(["checkout", "--quiet", "FETCH_HEAD"]);
await cp(resolve(checkout, "evals/evals"), destination, { recursive: true });
await writeFile(
  resolve(destination, ".source.json"),
  `${JSON.stringify(
    { repository: NEXTJS_EVALS_REPOSITORY, sha: NEXTJS_EVALS_SHA },
    null,
    2
  )}\n`,
  "utf8"
);
const entries = await readdir(destination, { withFileTypes: true });
const fixtureCount = entries.filter(
  (entry) => entry.isDirectory() && entry.name.startsWith("agent-")
).length;
if (fixtureCount !== 24) {
  throw new Error(`Expected 24 pinned eval fixtures, found ${fixtureCount}.`);
}
await rm(checkout, { force: true, recursive: true });
process.stdout.write(
  `Synced ${fixtureCount} Next.js eval fixtures at ${NEXTJS_EVALS_SHA}.\n`
);
