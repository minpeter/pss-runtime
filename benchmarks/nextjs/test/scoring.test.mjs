import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { formatScoreCsv, scoreCampaign } from "../src/scoring.mjs";

const scoreRowPattern = /agent-a,true,1,2,1000/u;

let campaign;

before(async () => {
  campaign = await mkdtemp(join(tmpdir(), "pss-score-"));
  for (const [name, statuses] of [
    ["agent-a", ["failed", "passed"]],
    ["agent-b", ["failed", "failed"]],
  ]) {
    const directory = join(campaign, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "summary.json"),
      JSON.stringify({
        evalName: name,
        results: statuses.map((status) => ({
          result: { duration: 1000, status },
        })),
      }),
      "utf8"
    );
  }
  const runDirectory = join(campaign, "agent-a", "run-0");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "transcript-raw.jsonl"),
    `${JSON.stringify({
      type: "result",
      result: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    })}\n`,
    "utf8"
  );
});

after(async () => {
  await rm(campaign, { recursive: true, force: true });
});

test("scores official any-pass and all-attempt reliability", async () => {
  const score = await scoreCampaign(campaign);
  assert.equal(score.officialScore, 0.5);
  assert.equal(score.attemptPassRate, 0.25);
  assert.equal(score.passedEvals, 1);
  assert.equal(score.totalEvals, 2);
  assert.equal(score.usage.totalTokens, 15);
  assert.match(formatScoreCsv(score), scoreRowPattern);
});
