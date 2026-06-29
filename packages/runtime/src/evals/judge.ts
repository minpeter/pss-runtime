import { generateObject, jsonSchema, type LanguageModel } from "ai";

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly reason: string;
  /** 0..1 score; higher is better. */
  readonly score: number;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const judgeSchema = jsonSchema({
  additionalProperties: false,
  properties: {
    pass: { type: "boolean" },
    reason: { type: "string" },
    score: { type: "number" },
  },
  required: ["pass", "reason", "score"],
  type: "object",
});

/**
 * Grade `value` against a natural-language `task` with an LLM judge. Mirrors
 * the Braintrust autoevals prompt shape: the judge is told its task, given the
 * value, and asked for a {score, pass, reason} object.
 */
export async function runJudge(
  model: LanguageModel,
  task: string,
  value: unknown
): Promise<JudgeVerdict> {
  const { object } = await generateObject({
    model,
    schema: judgeSchema,
    system:
      "You are an impartial judge. Grade how well the TARGET meets the TASK. " +
      "Respond as a single json object with exactly three keys: score (a float from 0 to 1), pass (a boolean), and reason (a short string).",
    prompt: `TASK:\n${task}\n\nTARGET:\n${stringify(value)}\n\nReturn only the json object described above.`,
  });
  const verdict = object as {
    pass?: unknown;
    reason?: unknown;
    score?: unknown;
  };
  const score =
    typeof verdict.score === "number"
      ? verdict.score
      : Number(verdict.score ?? 0);
  const pass = typeof verdict.pass === "boolean" ? verdict.pass : score >= 0.5;
  return {
    pass,
    reason: typeof verdict.reason === "string" ? verdict.reason : "",
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
  };
}

/** Build the judge TASK string for a given autoevals grader. */
export function closedQATask(criterion: string): string {
  return `Closed-QA: does the target meet this criterion? "${criterion}"`;
}

export function factualityTask(expected: string): string {
  return `Factuality: is the target factually consistent with this reference answer?\n\nREFERENCE:\n${expected}`;
}

export function summarizesTask(expected: string): string {
  return `Summarization: how well does the target summarize this reference text?\n\nREFERENCE:\n${expected}`;
}
