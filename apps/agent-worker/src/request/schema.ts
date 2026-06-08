import type {
  AgentInput,
  UserMessage,
  UserMessageContentPart,
} from "@minpeter/pss-runtime";
import { z } from "zod";

export const scenarioIds = [
  "foreground-basic",
  "multipart-input",
  "plugin-events",
  "tool-choice",
  "blocking-subagent",
  "durable-background",
  "background-output",
  "background-cancel",
  "steer-step-end",
  "duplicate-alarm",
  "resume-retry",
  "cancel-stale-child",
  "long-running-pingpong",
  "user-sandbox-file-edit",
  "request-rejection",
  "fanout-guard",
  "large-history-guard",
  "checkpoint-size-guard",
  "budget-guard",
] as const;

export type ScenarioId = (typeof scenarioIds)[number];

// App guards stay well below current Cloudflare platform ceilings:
// Workers Free: 10 ms CPU, 128 MB memory, 50 subrequests/request.
// Durable Object alarms: one scheduled alarm per object and 15 min wall time.
export const appBudgets = {
  maxBodyBytes: 32 * 1024,
  maxCheckpointBytes: 16 * 1024,
  maxFanout: 6,
  maxHeaderBytes: 16 * 1024,
  maxHistoryItems: 32,
  maxInputChars: 2048,
  maxMultipartParts: 4,
  maxPingPongDelayMs: 5 * 60 * 1000,
  maxPingPongHops: 12,
  maxPartChars: 2048,
  maxRouteTokenChars: 80,
  maxSandboxFileBytes: 8 * 1024,
  maxSummaryBytes: 8 * 1024,
  maxSummaryEvents: 24,
} as const;

export interface TurnRequest {
  readonly conversationId: string;
  readonly input: AgentInput;
  readonly scenario: ScenarioId;
  readonly stress: StressOptions;
  readonly tenantId: string;
  readonly userId: string;
}

export interface StressOptions {
  readonly checkpointBytes: number;
  readonly fanout: number;
  readonly historyItems: number;
  readonly pingPongDelayMs: number;
  readonly pingPongHops: number;
  readonly summaryEvents: number;
}

export type ParseTurnBodyResult =
  | { readonly ok: true; readonly status: 200; readonly value: TurnRequest }
  | { readonly error: string; readonly ok: false; readonly status: 400 };

const routeTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(appBudgets.maxRouteTokenChars);
const scenarioSchema = z.enum(scenarioIds);
const scenarioOptionsSchema = z
  .object({
    clock: z.literal("compressed").optional(),
    delayMs: z
      .number()
      .int()
      .min(1)
      .max(appBudgets.maxPingPongDelayMs)
      .optional(),
    hops: z.number().int().min(1).max(appBudgets.maxPingPongHops).optional(),
  })
  .strict();
const agentScenarioSchema = z
  .object({
    id: scenarioSchema,
    options: scenarioOptionsSchema.optional(),
  })
  .strict();
const scenarioInputSchema = z.union([scenarioSchema, agentScenarioSchema]);
const stressSchema = z
  .object({
    checkpointBytes: z
      .number()
      .int()
      .min(0)
      .max(appBudgets.maxCheckpointBytes)
      .optional(),
    fanout: z.number().int().min(1).max(appBudgets.maxFanout).optional(),
    historyItems: z
      .number()
      .int()
      .min(0)
      .max(appBudgets.maxHistoryItems)
      .optional(),
    pingPongDelayMs: z
      .number()
      .int()
      .min(1)
      .max(appBudgets.maxPingPongDelayMs)
      .optional(),
    pingPongHops: z
      .number()
      .int()
      .min(1)
      .max(appBudgets.maxPingPongHops)
      .optional(),
    summaryEvents: z
      .number()
      .int()
      .min(1)
      .max(appBudgets.maxSummaryEvents)
      .optional(),
  })
  .strict()
  .optional();
const textPartSchema = z
  .object({
    text: z.string().min(1).max(appBudgets.maxPartChars),
    type: z.literal("text"),
  })
  .strict();
const imagePartSchema = z
  .object({
    image: z.string().min(1).max(appBudgets.maxPartChars),
    mediaType: z.string().min(1).max(80).optional(),
    type: z.literal("image"),
  })
  .strict();
const fileDataSchema = z.union([
  z.string().min(1).max(appBudgets.maxPartChars),
  z.object({
    data: z.string().min(1).max(appBudgets.maxPartChars),
    type: z.literal("data"),
  }),
  z.object({
    text: z.string().min(1).max(appBudgets.maxPartChars),
    type: z.literal("text"),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string().url().max(appBudgets.maxPartChars),
  }),
]);
const filePartSchema = z
  .object({
    data: fileDataSchema,
    filename: z.string().min(1).max(120).optional(),
    mediaType: z.string().min(1).max(120),
    type: z.literal("file"),
  })
  .strict();
const multipartInputSchema = z
  .array(
    z.discriminatedUnion("type", [
      textPartSchema,
      imagePartSchema,
      filePartSchema,
    ])
  )
  .min(1)
  .max(appBudgets.maxMultipartParts);
const inputSchema = z.union([
  z.string().trim().min(1).max(appBudgets.maxInputChars),
  multipartInputSchema,
]);
const turnBodySchema = z
  .object({
    conversationId: routeTokenSchema,
    input: inputSchema,
    scenario: scenarioInputSchema,
    stress: stressSchema,
    tenantId: routeTokenSchema,
    userId: routeTokenSchema,
  })
  .strict();

export function parseTurnBody(value: unknown): ParseTurnBodyResult {
  const parsed = turnBodySchema.safeParse(value);
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
      ok: false,
      status: 400,
    };
  }

  return {
    ok: true,
    status: 200,
    value: {
      conversationId: parsed.data.conversationId,
      input: normalizeRequestInput(parsed.data.input),
      scenario: scenarioId(parsed.data.scenario),
      stress: stressOptions(parsed.data.scenario, parsed.data.stress),
      tenantId: parsed.data.tenantId,
      userId: parsed.data.userId,
    },
  };
}

export function totalHeaderBytes(headers: Headers): number {
  let total = 0;
  for (const [name, value] of headers) {
    total += name.length + value.length;
  }
  return total;
}

function normalizeRequestInput(
  input: string | readonly UserMessageContentPart[]
): AgentInput {
  if (typeof input === "string") {
    return input;
  }

  const message: UserMessage = {
    content: input,
    type: "user-message",
  };
  return message;
}

type ParsedScenario = z.infer<typeof scenarioInputSchema>;
type ParsedStress = z.infer<typeof stressSchema>;

function scenarioId(scenario: ParsedScenario): ScenarioId {
  return typeof scenario === "string" ? scenario : scenario.id;
}

function stressOptions(
  scenario: ParsedScenario,
  stress: ParsedStress
): StressOptions {
  const options = typeof scenario === "string" ? undefined : scenario.options;
  return {
    checkpointBytes: stress?.checkpointBytes ?? appBudgets.maxCheckpointBytes,
    fanout: stress?.fanout ?? 1,
    historyItems: stress?.historyItems ?? 1,
    pingPongDelayMs: stress?.pingPongDelayMs ?? options?.delayMs ?? 60_000,
    pingPongHops: stress?.pingPongHops ?? options?.hops ?? 6,
    summaryEvents: stress?.summaryEvents ?? appBudgets.maxSummaryEvents,
  };
}
