import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

export interface FixtureQuestion {
  readonly answer: string;
  readonly category:
    | "boundary-recall"
    | "constraint-retention"
    | "distractor-resolution"
    | "exact-recall"
    | "file-state"
    | "hallucination-resistance"
    | "negative-knowledge"
    | "task-continuation"
    | "temporal-resolution"
    | "tool-history";
  readonly question: string;
}

export type BenchmarkScenario = "baseline" | "boundary-noise" | "lifecycle";

export interface CompactionFixture {
  readonly compactionEnds: readonly number[];
  readonly messages: ModelMessage[];
  readonly questions: FixtureQuestion[];
  readonly scenario: BenchmarkScenario;
}

const sha = (input: string, length = 8): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

const user = (content: string): ModelMessage => ({ content, role: "user" });

const assistant = (content: string): ModelMessage => ({
  content,
  role: "assistant",
});

const assistantToolCall = (
  toolCallId: string,
  toolName: string,
  input: Record<string, string>
): ModelMessage => ({
  content: [{ input, toolCallId, toolName, type: "tool-call" }],
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

const DISTRACTOR_TOPICS = [
  "how flexbox gap behaves with wrapped rows",
  "why localStorage is synchronous",
  "the difference between em and rem",
  "how event delegation works",
  "why JSON.stringify drops undefined fields",
  "how CSS specificity is calculated",
  "what the defer attribute does on script tags",
  "how array reduce can build an index map",
  "why HTTP/2 multiplexing helps small assets",
  "how passive event listeners improve scroll performance",
  "what aria-live regions announce",
  "how AbortController cancels fetch requests",
  "why crypto.getRandomValues beats Math.random for ids",
  "how the browser parses HTML incrementally",
  "what contained layouts do for paint performance",
  "how queueMicrotask differs from setTimeout 0",
];

export function buildCompactionFixture(seed: string): CompactionFixture {
  const messages: ModelMessage[] = [];
  const questions: FixtureQuestion[] = [];

  const projectName = `orbit-${sha(`${seed}:project`, 4)}`;
  const finalPort = 8400 + (Number.parseInt(sha(`${seed}:port`, 2), 16) % 90);
  const apiToken = `tok_${sha(`${seed}:token`, 12)}`;
  const dbPath = `.data/${sha(`${seed}:db`, 6)}/tasks.db`;
  const licenseKey = `LIC-${sha(`${seed}:license`, 10).toUpperCase()}`;
  const cssVar = `--accent-${sha(`${seed}:cssvar`, 5)}`;
  const storageKey = `${projectName}:v${(Number.parseInt(sha(`${seed}:v`, 1), 16) % 5) + 1}`;
  const ownerEmail = `owner-${sha(`${seed}:owner`, 6)}@example.dev`;

  const exactFacts = [
    {
      answer: projectName,
      question: "What is the exact project codename?",
      statement: `The project codename is ${projectName}. Use it in every header comment.`,
    },
    {
      answer: String(finalPort),
      question: "What is the final dev server port?",
      statement: `Final decision: the dev server port is ${finalPort}. This supersedes any earlier port.`,
    },
    {
      answer: apiToken,
      question: "What is the exact API token we recorded?",
      statement: `Record this API token for the sync adapter: ${apiToken}.`,
    },
    {
      answer: dbPath,
      question: "What is the exact database file path?",
      statement: `The tasks database lives at ${dbPath}. Do not move it.`,
    },
    {
      answer: licenseKey,
      question: "What is the exact license key?",
      statement: `The commercial license key is ${licenseKey}.`,
    },
    {
      answer: cssVar,
      question: "What is the exact name of the accent CSS custom property?",
      statement: `Name the accent color custom property ${cssVar}.`,
    },
    {
      answer: storageKey,
      question: "What is the exact localStorage key for persisted tasks?",
      statement: `Persist tasks under the localStorage key ${storageKey}.`,
    },
    {
      answer: ownerEmail,
      question: "What is the exact owner email on file?",
      statement: `The owner of record is ${ownerEmail}.`,
    },
  ];

  const provisionalPort =
    3000 + (Number.parseInt(sha(`${seed}:pp`, 1), 16) % 9);
  const provisionalName = `nebula-${sha(`${seed}:pn`, 4)}`;
  const provisionalDb = `.data/legacy-${sha(`${seed}:pd`, 6)}/tasks.db`;
  const provisionalStorage = `${provisionalName}:v9`;

  const corrections = [
    {
      answer: String(finalPort),
      correction: `Correction: forget port ${provisionalPort}. The final dev server port is ${finalPort}.`,
      provisional: `Let's start the dev server on port ${provisionalPort} for now.`,
      question: "After all corrections, which port should the dev server bind?",
    },
    {
      answer: projectName,
      correction: `Correction: rename the project from ${provisionalName} to ${projectName}.`,
      provisional: `Provisionally calling the project ${provisionalName} until we decide.`,
      question: "After the rename, what is the final project codename?",
    },
    {
      answer: dbPath,
      correction: `Correction: the database moved from ${provisionalDb} to ${dbPath}.`,
      provisional: `Temporary database location: ${provisionalDb}.`,
      question: "After the move, where does the tasks database live?",
    },
    {
      answer: storageKey,
      correction: `Correction: migrate away from ${provisionalStorage}; the storage key is now ${storageKey}.`,
      provisional: `Until migration, tasks persist under ${provisionalStorage}.`,
      question: "After the migration, which localStorage key holds the tasks?",
    },
  ];

  const testRunOutput = `47 passed, 2 skipped, 0 failed; coverage ${80 + (Number.parseInt(sha(`${seed}:cov`, 1), 16) % 19)}.${Number.parseInt(sha(`${seed}:cov2`, 1), 16) % 10}%`;
  const buildHash = sha(`${seed}:build`, 10);
  const lintOutput = `0 errors, ${3 + (Number.parseInt(sha(`${seed}:lint`, 1), 16) % 6)} warnings (all no-console)`;
  const deployId = `dep_${sha(`${seed}:deploy`, 9)}`;

  const toolFacts = [
    {
      answer: testRunOutput,
      output: testRunOutput,
      question: "What was the exact output of the last full test run?",
      tool: "run_tests",
    },
    {
      answer: buildHash,
      output: `build ok; content hash ${buildHash}`,
      question: "What is the exact content hash from the last build?",
      tool: "run_build",
    },
    {
      answer: lintOutput,
      output: lintOutput,
      question: "What was the exact lint summary line?",
      tool: "run_lint",
    },
    {
      answer: deployId,
      output: `deployed to staging as ${deployId}`,
      question: "What is the exact staging deployment id?",
      tool: "deploy_preview",
    },
  ];

  const tasks = [
    { id: "task-scaffold", status: "done" },
    { id: "task-localstorage", status: "done" },
    { id: "task-dark-mode", status: "in-progress" },
    {
      blocker: "waiting on the design token export from the theme repo",
      id: "task-theme-sync",
      status: "blocked",
    },
    { id: "task-offline-queue", status: "queued" },
  ];
  const nextAction = `wire ${cssVar} into the toggle and finish task-dark-mode`;
  const board = tasks
    .map((task) =>
      task.status === "blocked"
        ? `- ${task.id}: ${task.status} (blocker: ${task.blocker})`
        : `- ${task.id}: ${task.status}`
    )
    .join("\n");

  const taskQuestions: FixtureQuestion[] = [
    {
      answer: "task-dark-mode",
      category: "task-continuation",
      question: "Which task is currently in progress?",
    },
    {
      answer: "waiting on the design token export from the theme repo",
      category: "task-continuation",
      question: "What exactly is blocking task-theme-sync?",
    },
    {
      answer: nextAction,
      category: "task-continuation",
      question: "What is the recorded next action?",
    },
    {
      answer: "queued",
      category: "task-continuation",
      question: "What is the status of task-offline-queue?",
    },
    {
      answer: "done",
      category: "task-continuation",
      question: "What is the status of task-localstorage?",
    },
    {
      answer: "task-offline-queue",
      category: "task-continuation",
      question: "Which task is still queued?",
    },
    {
      answer: "task-scaffold",
      category: "task-continuation",
      question: "Which task was completed first on the board?",
    },
    {
      answer: "blocked",
      category: "task-continuation",
      question: "What is the status of task-theme-sync?",
    },
  ];

  messages.push(
    user(
      `We are building a small vanilla JS task manager. ${exactFacts[0]?.statement ?? ""}`
    ),
    assistant(
      `Understood. I will use ${projectName} everywhere and keep the code dependency-free.`
    )
  );

  messages.push(
    user(exactFacts[6]?.statement ?? ""),
    assistant(`Noted: persistence key ${storageKey}.`)
  );

  for (const [index, correction] of corrections.entries()) {
    if (index % 2 === 0) {
      messages.push(
        user(correction.provisional),
        assistant("Recorded as the provisional value.")
      );
    }
  }

  messages.push(
    user("Let's check the current task board."),
    assistant(`Current board:\n${board}\nNext action: ${nextAction}.`)
  );

  for (const [index, fact] of exactFacts.slice(1, 5).entries()) {
    messages.push(
      user(fact.statement),
      assistant(`Recorded ${index + 1}: ${fact.answer}.`)
    );
  }

  for (const [index, fact] of toolFacts.entries()) {
    const callId = `call-${seed}-${index}`;
    messages.push(
      user(`Please run ${fact.tool}.`),
      assistantToolCall(callId, fact.tool, { cwd: "." }),
      toolResult(callId, fact.tool, fact.output),
      assistant(`${fact.tool} finished: ${fact.output}.`)
    );
  }

  for (const [index, fact] of exactFacts.slice(5).entries()) {
    messages.push(
      user(fact.statement),
      assistant(`Saved ${index + 5}: ${fact.answer}.`)
    );
  }

  for (const [index, correction] of corrections.entries()) {
    if (index % 2 === 1) {
      messages.push(
        user(correction.provisional),
        assistant("Recorded as the provisional value.")
      );
    }
  }

  for (const correction of corrections) {
    messages.push(
      user(correction.correction),
      assistant(`Updated. The final value is ${correction.answer}.`)
    );
  }

  for (const [index, topic] of DISTRACTOR_TOPICS.entries()) {
    messages.push(
      user(`Side question ${index + 1}: explain ${topic}.`),
      assistant(
        `On ${topic}: the short answer is detail ${sha(`${seed}:dist:${index}`, 6)}. ` +
          "In practice it behaves the way the spec describes, with the usual browser caveats, " +
          "and the pattern to remember is to keep the hot path small and measure before tuning."
      )
    );
  }

  for (const question of exactFacts) {
    questions.push({
      answer: question.answer,
      category: "exact-recall",
      question: question.question,
    });
  }
  for (const correction of corrections) {
    questions.push({
      answer: correction.answer,
      category: "distractor-resolution",
      question: correction.question,
    });
  }
  for (const fact of toolFacts) {
    questions.push({
      answer: fact.answer,
      category: "tool-history",
      question: fact.question,
    });
  }
  questions.push(...taskQuestions);

  const tail: ModelMessage[] = [
    user(
      "Before we continue, quick status check: anything about the padding work to note?"
    ),
    assistant(
      "The distractor research is done; nothing from it feeds the task manager directly."
    ),
    user("Ok. Next up I want to review the dark-mode toggle wiring together."),
    assistant(
      "Sounds good. I will walk through the toggle handler and the persistence path first."
    ),
    user("Also remind me later to bump the footer copy."),
    assistant(
      "Noted as a follow-up; I will surface it when we wrap the toggle work."
    ),
    user("Great, let us keep going in the next message."),
    assistant("Ready when you are."),
  ];
  messages.push(...tail);

  return {
    compactionEnds: [messages.length - tail.length],
    messages,
    questions,
    scenario: "baseline",
  };
}
