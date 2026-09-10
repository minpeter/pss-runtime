import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentEvent } from "@minpeter/pss-runtime";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectTurnDelivery,
  createConfiguredAgent,
  type WorkerAgentModelEnv,
} from "./agent/agent";
import type { Env } from "./env";
import worker from "./index";
import {
  createTurnEventCollector,
  type TurnObservabilityEntry,
} from "./observability";
import {
  attachmentLogFields,
  imagePrepareLogEvent,
  logInfo,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "./worker-log";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_DIR = join(SRC_DIR, "..");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");

const USER_TEXT = "MARKER-USER-TEXT-4c1d";
const ASSISTANT_REPLY = "MARKER-ASSISTANT-REPLY-7e20";
const ATTACHMENT_MARKER_B64 = "TUFSS0VSLUFUVEFDSE1FTlQtQkFTRTY0".repeat(8);
const SECRET_FILENAME = "secret-marker-passport-scan.png";

const HOSTED_BACKEND_PATTERN =
  /sentry|bugsnag|rollbar|datadog|dd-trace|honeycomb|newrelic|lightstep|logrocket/iu;
const IMAGE_PAYLOAD_FIELD_PATTERN = /base64|pixel/iu;
const TURN_METRIC_PATTERNS = [/agent_turn/u, /\bsteps\b/u, /toolCalls/u];
const COLLECTOR_CALL_PATTERN = /createTurnEventCollector\(\);/u;
const SUMMARY_CALL_PATTERN = /turnEvents\.summary\(\)/u;

function shippedSourceFiles(): string[] {
  const entries = readdirSync(SRC_DIR, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
    )
    .map((entry) =>
      relative(SRC_DIR, join(entry.parentPath, entry.name)).replaceAll(
        "\\",
        "/"
      )
    )
    .sort();
}

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_DIR, relPath), "utf8");
}

/**
 * evlog pretty mode writes via console.log under Vitest (it binds stdout at
 * module load), so spying console.* captures every emitted wide event.
 */
function spyOnConsoleWrites(): { readonly output: () => string } {
  const writes: string[] = [];
  const capture =
    () =>
    (...args: unknown[]) => {
      writes.push(args.map((arg) => String(arg)).join(" "));
    };
  vi.spyOn(console, "log").mockImplementation(capture());
  vi.spyOn(console, "info").mockImplementation(capture());
  vi.spyOn(console, "warn").mockImplementation(capture());
  vi.spyOn(console, "error").mockImplementation(capture());
  return { output: () => writes.join("\n") };
}

function chatCompletionResponse(): Response {
  const chunks = [
    {
      choices: [
        { delta: { role: "assistant" }, finish_reason: null, index: 0 },
      ],
      created: 0,
      id: "chatcmpl-metrics",
      model: "test-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        { delta: { content: ASSISTANT_REPLY }, finish_reason: null, index: 0 },
      ],
      created: 0,
      id: "chatcmpl-metrics",
      model: "test-model",
      object: "chat.completion.chunk",
    },
    {
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      created: 0,
      id: "chatcmpl-metrics",
      model: "test-model",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
    },
  ];
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

function testEnv(): WorkerAgentModelEnv {
  return {
    AI_API_KEY: "test-api-key",
    AI_BASE_URL: "https://ai.test/v1",
    AI_MODEL: "test-model",
    ENVIRONMENT: "development",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dependency and provider posture", () => {
  it("depends on @opentelemetry/api only — no SDK, exporter, or hosted backend", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")
    ) as {
      readonly dependencies: Record<string, string>;
      readonly devDependencies: Record<string, string>;
    };
    const allDeps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    });

    const otelDeps = allDeps.filter((name) =>
      name.startsWith("@opentelemetry/")
    );
    expect(otelDeps).toEqual(["@opentelemetry/api"]);

    const hostedBackend = allDeps.filter((name) =>
      HOSTED_BACKEND_PATTERN.test(name)
    );
    expect(hostedBackend).toEqual([]);
  });

  it("never registers an SDK provider in shipped sources", () => {
    for (const relPath of shippedSourceFiles()) {
      const code = readSrc(relPath);
      expect(
        code.includes("setGlobalTracerProvider"),
        `${relPath} must not register a tracer provider`
      ).toBe(false);
      expect(
        code.includes("setGlobalMeterProvider"),
        `${relPath} must not register a meter provider`
      ).toBe(false);
    }
  });

  it("documents that no provider is registered by default", () => {
    const doc = readFileSync(
      join(REPO_ROOT, "docs/worker-agent.md"),
      "utf8"
    ).toLowerCase();
    expect(doc).toContain("no provider is registered by default");
  });

  it("emits inert no-op spans and performs no network egress by default", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // No provider registered in this isolate: the API returns a no-op tracer.
    const span = trace.getTracer("pss-worker-agent").startSpan("probe");
    expect(span.isRecording()).toBe(false);
    span.setAttribute("probe", true);
    span.end();

    // Metric-only operations must not touch the network.
    logInfo({
      message: "metrics inert probe",
      ...attachmentLogFields([{ dataBase64: "AAAA", mediaType: "image/png" }]),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("turn observability never records message text", () => {
  it("scripted fixture turn: wide event carries counts/ids/names only", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(chatCompletionResponse()));
    const entries: TurnObservabilityEntry[] = [];
    const collector = createTurnEventCollector();
    const agent = await createConfiguredAgent(testEnv(), createInMemoryHost(), {
      observability: {
        log: (entry) => {
          entries.push(entry);
          collector.record(entry);
        },
      },
    });

    const turn = await agent.thread("metrics-fixture").send(USER_TEXT);
    const events: AgentEvent[] = [];
    await collectTurnDelivery(turn, {
      onEvent: (event) => {
        events.push(event);
      },
    });

    // The fixture turn really produced content-carrying events.
    expect(events.some((event) => event.type === "user-input")).toBe(true);
    expect(events.some((event) => event.type === "assistant-output")).toBe(
      true
    );

    // The collector dropped every content event.
    const contentEntries = entries.filter(
      (entry) =>
        entry.event === "user-input" || entry.event === "assistant-output"
    );
    expect(contentEntries).toEqual([]);

    // The wide-event turn block holds the fixed metric shape only.
    const summary = collector.summary();
    const turnBlock = {
      steps: summary.steps,
      toolCalls: summary.toolCalls,
      ...(summary.errors.length > 0 ? { errors: summary.errors } : {}),
    };
    expect(turnBlock.steps).toBeGreaterThanOrEqual(1);
    expect(Object.keys(turnBlock).sort()).toEqual(["steps", "toolCalls"]);

    const wideEventJson = JSON.stringify({ entries, turn: turnBlock });
    expect(wideEventJson).not.toContain(USER_TEXT);
    expect(wideEventJson).not.toContain(ASSISTANT_REPLY);
  });

  it("turn summary has a fixed bounded key set", () => {
    const collector = createTurnEventCollector();
    collector.record({ event: "turn-start" });
    collector.record({ event: "step-start" });
    collector.record({
      event: "tool-call",
      toolCallId: "call-1",
      toolName: "search",
    });
    collector.record({ event: "turn-error", message: "boom" });

    const summary = collector.summary();
    expect(Object.keys(summary).sort()).toEqual([
      "errors",
      "steps",
      "toolCalls",
    ]);
    expect(summary).toEqual({
      errors: ["boom"],
      steps: 1,
      toolCalls: ["search"],
    });
  });

  it("recording content-carrying entries never changes the summary", () => {
    const collector = createTurnEventCollector();
    collector.record({ event: "step-start" });
    collector.record({ event: "user-input" });
    collector.record({ event: "assistant-output" });

    const summary = collector.summary();
    expect(summary).toEqual({ errors: [], steps: 1, toolCalls: [] });
    expect(JSON.stringify(summary)).not.toContain(USER_TEXT);
  });
});

describe("attachment metrics are metadata-only", () => {
  it("attachment fields derive payloadBytes from base64 length and never echo payload", () => {
    const fields = attachmentLogFields([
      { dataBase64: ATTACHMENT_MARKER_B64, mediaType: "image/png" },
      { dataBase64: "AAAA", mediaType: "image/jpeg" },
    ]);

    expect(Object.keys(fields.attachments).sort()).toEqual([
      "count",
      "mediaTypes",
      "payloadBytes",
    ]);
    expect(fields.attachments).toEqual({
      count: 2,
      mediaTypes: ["image/png", "image/jpeg"],
      payloadBytes: Math.floor((ATTACHMENT_MARKER_B64.length + 4) * 3) / 4,
    });

    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(ATTACHMENT_MARKER_B64);
    expect(serialized).not.toContain(SECRET_FILENAME);
  });

  it("emitted attachment log lines never contain the marker base64", () => {
    const consoleWrites = spyOnConsoleWrites();

    try {
      logInfo({
        message: "turn attachments",
        ...attachmentLogFields([
          { dataBase64: ATTACHMENT_MARKER_B64, mediaType: "image/png" },
        ]),
      });
    } finally {
      vi.restoreAllMocks();
    }

    const emitted = consoleWrites.output();
    expect(emitted).toContain("payloadBytes");
    expect(emitted).not.toContain(ATTACHMENT_MARKER_B64);
  });

  it("image prepare events carry byte sizes, media types, geometry, alpha, limits only", () => {
    const event = imagePrepareLogEvent({
      decodedHeight: 600,
      decodedWidth: 800,
      hasAlpha: false,
      inputBytes: 66_540,
      inputMediaType: "image/png",
      maxImageBytes: 240_000,
      message: "pss-runtime image-prepare",
      outputBytes: 41_000,
      outputMediaType: "image/jpeg",
      path: "reencode_jpeg",
    });

    expect(Object.keys(event).sort()).toEqual([
      "decodedHeight",
      "decodedWidth",
      "hasAlpha",
      "inputBytes",
      "inputMediaType",
      "maxImageBytes",
      "message",
      "outputBytes",
      "outputMediaType",
      "path",
    ]);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(ATTACHMENT_MARKER_B64);
    expect(serialized).not.toContain(SECRET_FILENAME);
    expect(serialized).not.toMatch(IMAGE_PAYLOAD_FIELD_PATTERN);
  });

  it("image omit metric events never carry secret-bearing filenames", () => {
    const wide = summarizeImageOmits([
      {
        filename: SECRET_FILENAME,
        limit: "input_bytes",
        mediaType: "image/png",
      },
    ]);

    const serialized = JSON.stringify(wide);
    expect(serialized).not.toContain(SECRET_FILENAME);
    expect(serialized).not.toContain("filename");
    expect(wide).toEqual({
      imageOmits: {
        count: 1,
        omits: [{ limit: "input_bytes", mediaType: "image/png" }],
      },
    });
  });

  it("image prepare summaries stay metadata-only in wide events", () => {
    const wide = summarizeImagePrepares([
      {
        inputBytes: 100,
        inputMediaType: "image/jpeg",
        outputBytes: 100,
        outputMediaType: "image/jpeg",
        path: "passthrough_jpeg",
      },
    ]);
    const serialized = JSON.stringify(wide);
    expect(serialized).not.toContain(ATTACHMENT_MARKER_B64);
    expect(serialized).not.toContain(SECRET_FILENAME);
  });
});

describe("read-only probes emit zero turn metrics", () => {
  function createProbeEnv(): {
    agentDoGetCalls: () => number;
    env: Env;
  } {
    let getCalls = 0;
    const namespace = {
      get() {
        getCalls += 1;
        throw new Error("AGENT_DO get() must not run during read-only probes");
      },
    } as unknown as DurableObjectNamespace;
    const env = {
      AGENT_DO: namespace,
      AI_API_KEY: "placeholder-ai-key",
      AI_BASE_URL: "http://127.0.0.1:9/unreachable",
      AI_MODEL: "placeholder-model",
      ENVIRONMENT: "development",
      TELEGRAM_BOT_TOKEN: "placeholder-bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "placeholder_webhook_secret",
      WORKER_AGENT_TUI_TOKEN: "test-tui-token",
    } as unknown as Env;
    return { agentDoGetCalls: () => getCalls, env };
  }

  function probe(env: Env, path: string): Promise<Response> {
    return worker.fetch(
      new Request(`http://worker.local${path}`, { method: "GET" }),
      env,
      {
        waitUntil() {
          // no-op: read-only probes schedule no background work
        },
      } as unknown as ExecutionContext
    );
  }

  it("health, replay, and SSE probes run no turn path and no DO hop", async () => {
    const { agentDoGetCalls, env } = createProbeEnv();

    const health = await probe(env, "/healthz");
    expect(health.status).toBe(200);

    // Auth precedes input parsing and dispatch: 401, no DO hop, no turn.
    const replay = await probe(env, "/trpc/session.replayEvents");
    expect(replay.status).toBe(401);

    const sse = await probe(env, "/session/events?channel=tui%3Alocal");
    expect(sse.status).toBe(401);

    const sseNoChannel = await probe(env, "/session/events");
    expect([400, 401]).toContain(sseNoChannel.status);

    expect(agentDoGetCalls()).toBe(0);
  });

  it("only the DO turn-delivery path constructs turn metric collectors", () => {
    // `createTurnEventCollector();` matches call sites only — the definition
    // in observability.ts is `createTurnEventCollector():` (no semicolon).
    const callSites = shippedSourceFiles().filter((relPath) =>
      COLLECTOR_CALL_PATTERN.test(readSrc(relPath))
    );
    expect(callSites).toEqual(["agent/agent-do-turn-delivery.ts"]);

    const summarySites = shippedSourceFiles().filter((relPath) =>
      SUMMARY_CALL_PATTERN.test(readSrc(relPath))
    );
    expect(summarySites.sort()).toEqual([
      "agent/agent-do-turn-delivery-response.ts",
      "agent/agent-do-turn-delivery.ts",
    ]);
  });

  it("read-only probe wide events contain no turn/step/tool metric fields", async () => {
    const { env } = createProbeEnv();
    const consoleWrites = spyOnConsoleWrites();

    try {
      await probe(env, "/healthz");
      await probe(env, "/trpc/session.replayEvents");
      await probe(env, "/session/events?channel=tui%3Alocal");
    } finally {
      vi.restoreAllMocks();
    }

    const emitted = consoleWrites.output();
    // Non-vacuous: the probes really emitted wide request events.
    expect(emitted).toContain("handler");
    for (const pattern of TURN_METRIC_PATTERNS) {
      expect(emitted).not.toMatch(pattern);
    }
  });
});
