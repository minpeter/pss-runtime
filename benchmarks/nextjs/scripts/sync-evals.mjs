import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEXTJS_EVALS_REPOSITORY,
  NEXTJS_EVALS_SHA,
} from "../src/constants.mjs";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(benchmarkRoot, ".evals-checkout");
const destination = resolve(benchmarkRoot, "evals");
const stagedDestination = resolve(benchmarkRoot, ".evals-staging");
const lockPath = resolve(benchmarkRoot, ".evals-sync.lock");

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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return Boolean(
      error && typeof error === "object" && error.code === "EPERM"
    );
  }
}

function contentionError() {
  return new Error(
    "Another eval sync is in progress (.evals-sync.lock exists); remove it if a previous run was interrupted."
  );
}

// mkdir is atomic on POSIX: exactly one concurrent sync wins the lock. A
// lock whose recorded owner is gone is reclaimed (interrupted run); the
// takeover rename is atomic, so exactly one reclaimer wins.
async function acquireLock() {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") {
      throw error;
    }
    const owner = await readFile(resolve(lockPath, "pid"), "utf8").catch(
      () => ""
    );
    const pid = Number.parseInt(owner, 10);
    if (!Number.isInteger(pid) || isProcessAlive(pid)) {
      throw contentionError();
    }
    const tombstone = resolve(
      benchmarkRoot,
      `.evals-sync.lock.stale-${process.pid}`
    );
    await rm(tombstone, { force: true, recursive: true });
    try {
      await rename(lockPath, tombstone);
    } catch (renameError) {
      if (
        renameError &&
        typeof renameError === "object" &&
        renameError.code === "ENOENT"
      ) {
        throw contentionError();
      }
      throw renameError;
    }
    await rm(tombstone, { force: true, recursive: true });
    try {
      await mkdir(lockPath);
    } catch (mkdirError) {
      if (
        mkdirError &&
        typeof mkdirError === "object" &&
        mkdirError.code === "EEXIST"
      ) {
        throw contentionError();
      }
      throw mkdirError;
    }
  }
  await writeFile(resolve(lockPath, "pid"), String(process.pid), "utf8");
}

async function releaseLock() {
  const owner = await readFile(resolve(lockPath, "pid"), "utf8").catch(
    () => ""
  );
  // Only remove the lock while we still own it.
  if (Number.parseInt(owner, 10) === process.pid) {
    await rm(lockPath, { force: true, recursive: true });
  }
}

await acquireLock();

try {
  await rm(checkout, { force: true, recursive: true });
  await rm(stagedDestination, { force: true, recursive: true });
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
  // Stage the new fixtures beside the destination, then swap in one rename
  // so readers never observe a half-copied evals/ directory.
  await cp(resolve(checkout, "evals/evals"), stagedDestination, {
    recursive: true,
  });
  await writeFile(
    resolve(stagedDestination, ".source.json"),
    `${JSON.stringify(
      { repository: NEXTJS_EVALS_REPOSITORY, sha: NEXTJS_EVALS_SHA },
      null,
      2
    )}\n`,
    "utf8"
  );
  const entries = await readdir(stagedDestination, { withFileTypes: true });
  const fixtureCount = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("agent-")
  ).length;
  if (fixtureCount !== 24) {
    throw new Error(`Expected 24 pinned eval fixtures, found ${fixtureCount}.`);
  }
  await rm(destination, { force: true, recursive: true });
  await rename(stagedDestination, destination);
  process.stdout.write(
    `Synced ${fixtureCount} Next.js eval fixtures at ${NEXTJS_EVALS_SHA}.\n`
  );
} finally {
  await rm(checkout, { force: true, recursive: true });
  await rm(stagedDestination, { force: true, recursive: true });
  await releaseLock();
}
