import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ALL_TOOL_NAMES,
  orderedTools,
  outputWasExactOk,
  responseModel,
  staticPrefix,
} from "./benchmark-cache-stable-tools.mts";

const BASE_URL = "https://freerouter.minpeter.workers.dev/v1";
const MODEL = "mistralai/ministral-14b-latest";
const OUTPUT =
  "benchmarks/cache-stable-tools/mistral-response-shape-probe.json";
const BEARER_PATTERN = /Bearer\s/iu;

function valueKind(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function ownValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function boundedArrayLength(value: unknown): number | null {
  return Array.isArray(value) && value.length <= 1000 ? value.length : null;
}

function responseShape(body: unknown, requestedModel: string) {
  const choices = ownValue(body, "choices");
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = ownValue(firstChoice, "message");
  const toolCalls = ownValue(message, "tool_calls");
  const functionCall = ownValue(message, "function_call");
  const content = ownValue(message, "content");
  const observedModel = responseModel(body);
  return {
    rootKind: valueKind(body),
    choices: {
      kind: valueKind(choices),
      length: boundedArrayLength(choices),
      present:
        body !== null &&
        typeof body === "object" &&
        Object.hasOwn(body, "choices"),
    },
    firstChoiceKind: valueKind(firstChoice),
    message: {
      kind: valueKind(message),
      present:
        firstChoice !== null &&
        typeof firstChoice === "object" &&
        Object.hasOwn(firstChoice, "message"),
    },
    toolCalls: {
      kind: valueKind(toolCalls),
      length: boundedArrayLength(toolCalls),
      present:
        message !== null &&
        typeof message === "object" &&
        Object.hasOwn(message, "tool_calls"),
    },
    functionCall: {
      kind: valueKind(functionCall),
      present:
        message !== null &&
        typeof message === "object" &&
        Object.hasOwn(message, "function_call"),
    },
    content: {
      exactTrimmedOk: outputWasExactOk(body),
      kind: valueKind(content),
      present:
        message !== null &&
        typeof message === "object" &&
        Object.hasOwn(message, "content"),
    },
    model: {
      matchesRequested:
        observedModel === null ? null : observedModel === requestedModel,
      safeIdReported: observedModel !== null,
    },
    usage: {
      kind: valueKind(ownValue(body, "usage")),
      present:
        body !== null &&
        typeof body === "object" &&
        Object.hasOwn(body, "usage"),
    },
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.CACHE_BENCH_API_KEY?.trim();
  if (!apiKey) {
    throw new TypeError("CACHE_BENCH_API_KEY is required.");
  }
  const isolationToken = "shapeprobe00000000000000";
  const requestBody = JSON.stringify({
    max_tokens: 8,
    messages: [
      {
        content: staticPrefix(`cache-arm-${isolationToken}`, 700),
        role: "system",
      },
      {
        content: "Reply with exactly OK and do not call a tool.",
        role: "user",
      },
    ],
    model: MODEL,
    stream: false,
    tools: orderedTools(ALL_TOOL_NAMES, isolationToken),
  });
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    body: requestBody,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const result = {
    credentialRecorded: false,
    endpoint: BASE_URL,
    generatedAt: new Date().toISOString(),
    httpStatus: response.status,
    httpSuccess: response.ok,
    protocol: "openai-chat-completions",
    requestedModel: MODEL,
    responseShape: responseShape(body, MODEL),
    schemaVersion: 1,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (serialized.includes(apiKey) || BEARER_PATTERN.test(serialized)) {
    throw new Error("Refusing to write probe output containing a credential.");
  }
  const outputPath = resolve(OUTPUT);
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  process.stderr.write(`Wrote ${outputPath}\n`);
}

await main();
