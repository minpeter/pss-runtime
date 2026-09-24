/**
 * Hold-out fixtures for auditing compaction-quality results.
 *
 * These scenarios were written after freezing the runtime ledger heuristics
 * and deliberately avoid every surface pattern the original fixtures use:
 * no `FINAL_*=` assignments, no `[debug:...]` noise prefixes, no vocabulary
 * from any historical salience keyword list. Noise is JSON-lines, Korean
 * prose, and timestamped INFO logs; facts sit at early, middle, and late
 * log positions. Implementation changes after observing hold-out results
 * would re-contaminate them.
 */
import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import {
  type CompactionFixture,
  type FixtureQuestion,
  validateCompactionFixture,
} from "./fixture";

const user = (content: string): ModelMessage => ({ content, role: "user" });
const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});
const sha = (input: string, length = 8): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

const toolCall = (toolCallId: string, toolName: string): ModelMessage => ({
  content: [
    { input: { scope: "all" }, toolCallId, toolName, type: "tool-call" },
  ],
  role: "assistant",
});

const toolResult = (
  toolCallId: string,
  toolName: string,
  value: string
): ModelMessage => ({
  content: [
    {
      output: { type: "text", value },
      toolCallId,
      toolName,
      type: "tool-result",
    },
  ],
  role: "tool",
});

const question = (
  category: FixtureQuestion["category"],
  answer: string,
  text: string
): FixtureQuestion => ({ answer, category, question: text });

export function buildHoldoutFixture(
  scenario: "holdout-json" | "holdout-cjk" | "holdout-log",
  seed: string
): CompactionFixture {
  if (scenario === "holdout-json") {
    return buildHoldoutJsonFixture(seed);
  }
  if (scenario === "holdout-cjk") {
    return buildHoldoutCjkFixture(seed);
  }
  return buildHoldoutLogFixture(seed);
}

function buildHoldoutJsonFixture(seed: string): CompactionFixture {
  const checksum = sha(`${seed}:checksum`, 16);
  const undoCommand = `exportctl undo ${sha(`${seed}:undo`, 9)}`;
  const reviewToken = `rev_${sha(`${seed}:review`, 12)}`;
  const haltReason = "quota window exhausted";
  const rows = "58231";
  const columns = "17";

  const jsonNoise = (phase: string, count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `{"level":"info","event":"tick","phase":"${phase}","seq":${index},"lag_ms":${(index * 7) % 143}}`
    );
  const exportLog = [
    `{"event":"schema_locked","columns":${columns}}`,
    ...jsonNoise("early", 80),
    `{"event":"finalized","checksum":"${checksum}","rows":${rows}}`,
    ...jsonNoise("late", 80),
    `{"event":"undo_hint","command":"${undoCommand}"}`,
  ].join("\n");

  const messages: ModelMessage[] = [
    user(
      "Export the orders dataset and verify its integrity before publishing."
    ),
    assistant("I will export the dataset and verify every recorded value."),
    user("Hard requirement: keep the column order stable across exports."),
    assistant("Column order stability is recorded as a hard requirement."),
    user("Provisional dataset name: orders_v2."),
    assistant("orders_v2 noted as provisional."),
    user("Run the export now."),
    toolCall("export-1", "export_report"),
    toolResult(
      "export-1",
      "export_report",
      `{"event":"halted","reason":"${haltReason}"}`
    ),
    assistant("The first export halted without producing a report."),
    user("Retry the export with the full quota."),
    toolCall("export-2", "export_report"),
    toolResult("export-2", "export_report", exportLog),
    assistant(
      "The export completed; the log carries the definitive values and I will not restate them here."
    ),
    user("Correction: the dataset name is orders_final, not orders_v2."),
    assistant("Dataset name recorded as orders_final."),
    user(`The review token for this export is ${reviewToken}.`),
    assistant("The review token is recorded unchanged."),
    user(
      "Next action: publish orders_final to the metrics bucket, then close ticket TCK-4410."
    ),
    assistant("Publish to the metrics bucket, then close TCK-4410."),
  ];
  const end = messages.length;
  messages.push(
    user("Let's talk about the readme wording now."),
    assistant("Readme wording does not change any recorded export value."),
    user("Keep the export facts unchanged while we edit prose."),
    assistant("All export facts remain exactly as recorded.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "exact-recall",
      checksum,
      "What exact checksum appears in the export log?"
    ),
    question(
      "exact-recall",
      undoCommand,
      "What exact undo command appears in the export log?"
    ),
    question("tool-history", rows, "Exactly how many rows were finalized?"),
    question(
      "tool-history",
      columns,
      "Exactly how many columns were schema-locked?"
    ),
    question(
      "negative-knowledge",
      haltReason,
      "What exact reason halted the first export?"
    ),
    question(
      "temporal-resolution",
      "orders_final",
      "What is the final dataset name?"
    ),
    question(
      "boundary-recall",
      reviewToken,
      "What is the exact review token stated for this export?"
    ),
    question(
      "task-continuation",
      "publish orders_final to the metrics bucket, then close ticket TCK-4410",
      "What is the recorded next action?"
    ),
  ];

  return validateCompactionFixture({
    compactionEnds: [end],
    messages,
    questions,
    scenario: "holdout-json",
  });
}

function buildHoldoutCjkFixture(seed: string): CompactionFixture {
  const verifyHash = sha(`${seed}:Verify`, 16);
  const restoreCommand = `bae undo ${sha(`${seed}:Restore`, 9)}`;
  const region = "kr-central-2";
  const failedLesson =
    "Do not retry memory cache freeloading - cold start delay tripled";

  const cjkNoise = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `Reminder: Cache Items ${index + 1000}has been renewed (delayed) ${(index * 3) % 97}ms)`
    );
  const deployLog = [
    `Target Region is ${region} venky`,
    ...cjkNoise(110),
    `The final validation hash ${verifyHash} venky`,
    ...cjkNoise(110),
    `Restore procedure: ${restoreCommand}`,
  ].join("\n");

  const messages: ModelMessage[] = [
    user(
      "Proceed with payment service deployment and ensure all validated values are preserved correctly."
    ),
    assistant(
      "As we proceed with the deployment, we will preserve the validation values as they."
    ),
    user("Constraints: Public API Never change your name."),
    assistant("Transparent API Restrictions on name change recorded."),
    user("Temporary port is 8080."),
    assistant("Port 8080 has been logged as a temporary value."),
    user("Please check the deployment log."),
    toolCall("deploy-1", "read_deploy_log"),
    toolResult("deploy-1", "read_deploy_log", deployLog),
    assistant(
      "The value in the deployment log is the final copy and I will not repeat it here."
    ),
    user("Correction: The final port is 8443, not 8080."),
    assistant("I logged the final port as 8443.."),
    user(`Failure Lessons: ${failedLesson}.`),
    assistant("We have logged this access so that it will not be retried."),
    user(
      "Next action: Attach health check to port 8443 and close distribution ticket."
    ),
    assistant(
      "8443 I will close the distribution ticket after connecting the health check."
    ),
  ];
  const end = messages.length;
  messages.push(
    user("Now let's just refine the release note text.."),
    assistant(
      "Release notes wording will not affect the recorded deployment value."
    ),
    user("Do not change the distribution value during stationery operations."),
    assistant("Distribution values will remain as recorded.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "exact-recall",
      verifyHash,
      "What is the exact final validation hash recorded in the deployment log?"
    ),
    question(
      "exact-recall",
      restoreCommand,
      "What is the exact restore command recorded in the deployment log??"
    ),
    question(
      "tool-history",
      region,
      "What is the exact target region recorded in the deployment log??"
    ),
    question(
      "temporal-resolution",
      "8443",
      "Exactly how many times is the final port??"
    ),
    question(
      "negative-knowledge",
      failedLesson,
      "Exactly what approach should not be retried and why??"
    ),
    question(
      "constraint-retention",
      "Transparent API Never change the name ",
      "Recorded Disclosures API What are the exact constraints??"
    ),
    question(
      "task-continuation",
      "8443 Please paste the health check into the port and close the distribution ticket ",
      "What's the next task that's been recorded??"
    ),
  ];

  return validateCompactionFixture({
    compactionEnds: [end],
    messages,
    questions,
    scenario: "holdout-cjk",
  });
}

function buildHoldoutLogFixture(seed: string): CompactionFixture {
  const experimentId = `exp-${sha(`${seed}:experiment`, 10)}`;
  const snapshotTag = `v1.4.0-rc3.${sha(`${seed}:snapshot`, 4)}`;
  const winnerLine = "winner determined: variant B-217 conversion 4.83%";
  const emptyReason = "no rows: retention filter mismatched";

  const infoNoise = (count: number, offset: number): string[] =>
    Array.from(
      { length: count },
      (_, index) =>
        `2026-07-26 10:${String((index + offset) % 60).padStart(2, "0")}:${String(
          index % 60
        ).padStart(
          2,
          "0"
        )} INFO worker-${(index % 5) + 1} heartbeat seq=${index + offset}`
    );
  const experimentLog = [
    `analysis started for ${experimentId}`,
    ...infoNoise(100, 0),
    winnerLine,
    ...infoNoise(100, 200),
    `run finished; snapshot tag ${snapshotTag}`,
  ].join("\n");

  const messages: ModelMessage[] = [
    user(
      "Analyze the checkout experiment and keep every measured value exact."
    ),
    assistant("I will analyze the experiment and keep measurements exact."),
    user("Provisional sample size: 40000 sessions."),
    assistant("Sample size 40000 recorded as provisional."),
    user("Query the experiment results."),
    toolCall("query-1", "fetch_experiment_log"),
    toolResult("query-1", "fetch_experiment_log", emptyReason),
    assistant("The first query returned nothing usable."),
    user("Fix the filter and fetch the full log."),
    toolCall("query-2", "fetch_experiment_log"),
    toolResult("query-2", "fetch_experiment_log", experimentLog),
    assistant(
      "The full log is authoritative for every measurement; I will not repeat its values here."
    ),
    user("Correction: the sample size was 62000 sessions, not 40000."),
    assistant("Sample size recorded as 62000 sessions."),
    user("Next action: archive the losing variant and brief the growth team."),
    assistant("Archive the losing variant, then brief the growth team."),
  ];
  const end = messages.length;
  messages.push(
    user("Now let's rename the dashboard widgets."),
    assistant("Widget names do not change any measured value."),
    user("Keep the experiment numbers frozen while we rename things."),
    assistant("All experiment numbers stay exactly as measured.")
  );

  const questions: FixtureQuestion[] = [
    question(
      "exact-recall",
      winnerLine,
      "What exact winner line appears in the experiment log?"
    ),
    question(
      "exact-recall",
      snapshotTag,
      "What exact snapshot tag appears in the experiment log?"
    ),
    question(
      "tool-history",
      experimentId,
      "What exact experiment id was analyzed?"
    ),
    question(
      "negative-knowledge",
      emptyReason,
      "What exact output came from the failed first query?"
    ),
    question(
      "temporal-resolution",
      "62000",
      "How many sessions were in the final sample? Answer with digits only."
    ),
    question(
      "task-continuation",
      "archive the losing variant and brief the growth team",
      "What is the recorded next action?"
    ),
  ];

  return validateCompactionFixture({
    compactionEnds: [end],
    messages,
    questions,
    scenario: "holdout-log",
  });
}
