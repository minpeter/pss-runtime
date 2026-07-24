import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import type { CompactionFixture } from "./fixture";
import { summarizeTrials, type TrialRecord } from "./report";
import {
  buildScenarioFixture,
  scenarioForFixtureIndex,
} from "./scenario-fixtures";
import { runCompactionTrial } from "./trial-runner";

interface BenchmarkOptions {
  readonly fixtures: number;
  readonly maxAttempts: number;
  readonly outputDir: string;
  readonly seed: string;
  readonly summaryMaxOutputTokens: number;
  readonly trials: number;
}

const HELP = `Usage: pnpm score -- [options]

Options:
  --fixtures N                  Independent fixture seeds (default: 3)
  --trials N                    Valid repetitions per fixture (default: 2)
  --max-attempts N              Attempts per fixture/repetition (default: 3)
  --seed STRING                 Base fixture seed
  --summary-max-output-tokens N Hard summary output cap (default: 1024)
  --output PATH                 Report directory
  --help                        Show this help`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(HELP);
} else {
  await runBenchmark(parseOptions(args));
}

async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const model = createCodingLanguageModel();
  const records: TrialRecord[] = [];
  const fixtureRecords: CompactionFixture[] = [];
  const trialsPath = join(options.outputDir, "trials.jsonl");
  const targetValidTrials = options.fixtures * options.trials;

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(
    join(options.outputDir, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        model: process.env.AI_MODEL ?? "default",
        options,
        protocol: {
          answerCallsPerTrial: 2,
          armOrder: "rotated by repetition",
          fullControlRequired: true,
          score: "compacted exact-match retention",
          summaryCallsPerTrial: "fixture compaction hop count",
          temperature: 0,
        },
      },
      null,
      2
    )
  );

  for (
    let fixtureIndex = 0;
    fixtureIndex < options.fixtures;
    fixtureIndex += 1
  ) {
    const scenario = scenarioForFixtureIndex(fixtureIndex);
    const fixtureSeed = `${options.seed}-${scenario}-${fixtureIndex + 1}`;
    const fixture = buildScenarioFixture(scenario, fixtureSeed);
    fixtureRecords.push(fixture);

    for (let repetition = 1; repetition <= options.trials; repetition += 1) {
      let valid = false;
      for (
        let attempt = 1;
        attempt <= options.maxAttempts && !valid;
        attempt += 1
      ) {
        const id = `f${fixtureIndex + 1}-r${repetition}-a${attempt}`;
        console.log(
          `[${id}] scenario=${scenario} hops=${fixture.compactionEnds.length} questions=${fixture.questions.length}`
        );
        const record = await runCompactionTrial({
          attempt,
          fixture,
          fixtureSeed,
          id,
          model,
          repetition,
          seed: numericSeed(`${fixtureSeed}:${repetition}:${attempt}`),
          summaryMaxOutputTokens: options.summaryMaxOutputTokens,
        });
        records.push(record);
        await appendFile(trialsPath, `${JSON.stringify(record)}\n`);

        if (record.status === "valid") {
          valid = true;
          console.log(
            `  valid compacted=${record.score.headline.correct}/${record.score.headline.total} summaryRatio=${(record.summaryTokens / record.prefixTokens).toFixed(3)}`
          );
        } else {
          console.log(
            `  invalid status=${record.status} error=${record.error}`
          );
        }
      }
    }
  }

  await writeFile(
    join(options.outputDir, "fixtures.json"),
    JSON.stringify(fixtureRecords, null, 2)
  );
  const summary = summarizeTrials(records);
  await writeFile(
    join(options.outputDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  console.log(JSON.stringify(summary, null, 2));
  console.log(`report: ${options.outputDir}`);

  if (summary.trials.valid < targetValidTrials) {
    console.error(
      `Only ${summary.trials.valid}/${targetValidTrials} required valid trials completed.`
    );
    process.exitCode = 1;
  }
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const read = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : (args[index + 1] ?? fallback);
  };

  return {
    fixtures: positiveInteger(read("--fixtures", "3"), "--fixtures"),
    maxAttempts: positiveInteger(read("--max-attempts", "3"), "--max-attempts"),
    outputDir: read(
      "--output",
      join(tmpdir(), `compaction-score-${timestamp}`)
    ),
    seed: read("--seed", "compaction-score-v2"),
    summaryMaxOutputTokens: positiveInteger(
      read("--summary-max-output-tokens", "1024"),
      "--summary-max-output-tokens"
    ),
    trials: positiveInteger(read("--trials", "2"), "--trials"),
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function numericSeed(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}
