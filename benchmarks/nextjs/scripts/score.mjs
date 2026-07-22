import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatScoreCsv, scoreCampaign } from "../src/scoring.mjs";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function findManifests(directory) {
  const manifests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...(await findManifests(path)));
    } else if (entry.name === "benchmark-manifest.json") {
      manifests.push(path);
    }
  }
  return manifests;
}

async function latestCampaign() {
  const manifests = await findManifests(resolve(benchmarkRoot, "results"));
  const dated = await Promise.all(
    manifests.map(async (path) => ({
      path,
      modified: (await stat(path)).mtimeMs,
    }))
  );
  dated.sort((left, right) => right.modified - left.modified);
  if (!dated[0]) {
    throw new Error("No benchmark campaign result was found.");
  }
  return dirname(dated[0].path);
}

const campaignDirectory = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : await latestCampaign();
const score = await scoreCampaign(campaignDirectory);
const manifest = JSON.parse(
  await readFile(resolve(campaignDirectory, "benchmark-manifest.json"), "utf8")
);
const exported = { campaignDirectory, manifest, score };
await writeFile(
  resolve(campaignDirectory, "score.json"),
  `${JSON.stringify(exported, null, 2)}\n`,
  "utf8"
);
await writeFile(
  resolve(campaignDirectory, "score.csv"),
  formatScoreCsv(score),
  "utf8"
);
process.stdout.write(
  `Official score: ${score.passedEvals}/${score.totalEvals} (${(
    score.officialScore * 100
  ).toFixed(2)}%)\nAttempt pass rate: ${score.passedAttempts}/${
    score.totalAttempts
  } (${(score.attemptPassRate * 100).toFixed(2)}%)\nResults: ${campaignDirectory}\n`
);
