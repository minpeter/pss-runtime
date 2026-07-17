import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_ZERO_TOOL_FINISH_REASONS,
  ALL_TOOL_NAMES,
  benchmarkRequestArtifacts,
  cacheMeasurementIsValid,
  EVIDENCE_CAMPAIGN,
  EVIDENCE_CAMPAIGN_TOPOLOGY,
  extractUsage,
  isolationTokenFor,
  MEMBERSHIP_SCENARIO,
  orderedTools,
  outputWasExactOk,
  pairOrderFor,
  parseOptions,
  responseFinishReasonStatuses,
  responseModel,
  responseToolCallCount,
  runBenchmark,
  safeTokenSum,
  serializeBenchmarkResult,
  variantSummary,
} from "./benchmark-cache-stable-tools.mts";

const ISOLATION_TOKEN_PATTERN = /^[0-9a-f]{24}$/u;

describe("cache-stable benchmark methodology", () => {
  it("fails closed when cache aliases disagree", () => {
    expect(
      extractUsage({
        usage: {
          input_tokens_details: { cache_write_tokens: 29 },
          prompt_tokens_details: {
            cache_creation_tokens: 11,
            cache_write_tokens: 23,
          },
        },
      })
    ).toMatchObject({
      cacheWriteSource: null,
      cacheWriteTokens: null,
      usageFieldAudit: { cacheWrite: "conflict" },
    });
  });

  it("accepts duplicate usage aliases only when their values agree", () => {
    expect(
      extractUsage({
        usage: {
          input_tokens: 100,
          prompt_tokens: 100,
          input_tokens_details: { cached_tokens: 40 },
          prompt_tokens_details: { cached_tokens: 40 },
        },
      })
    ).toMatchObject({
      cacheReadSource: "prompt_tokens_details.cached_tokens",
      cacheReadTokens: 40,
      inputSource: "prompt_tokens",
      inputTokens: 100,
      usageFieldAudit: { cacheRead: "valid", input: "valid" },
    });
    expect(
      extractUsage({
        usage: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: "40" },
        },
      })
    ).toMatchObject({
      cacheReadSource: null,
      cacheReadTokens: null,
      usageFieldAudit: { cacheRead: "invalid" },
    });
  });

  it("detects tool calls and exact text without retaining response content", () => {
    const exact = {
      choices: [
        {
          finish_reason: "stop",
          message: { content: " OK ", tool_calls: [] },
        },
      ],
    };
    const toolCall = {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ function: { arguments: "{}", name: "inert" } }],
          },
        },
      ],
    };

    expect(responseToolCallCount(exact)).toBe(0);
    expect(responseFinishReasonStatuses(exact)).toEqual(["accepted-stop"]);
    expect(outputWasExactOk(exact)).toBe(true);
    expect(
      responseToolCallCount({
        choices: [{ message: { content: "OK", tool_calls: null } }],
      })
    ).toBe(0);
    expect(responseToolCallCount(toolCall)).toBe(1);
    expect(responseFinishReasonStatuses(toolCall)).toEqual([
      "rejected-tool-calls",
    ]);
    expect(outputWasExactOk(toolCall)).toBeNull();
    expect(responseToolCallCount({ choices: [] })).toBeNull();
    expect(responseToolCallCount({ choices: [{ message: [] }] })).toBeNull();
    expect(responseToolCallCount({ choices: [[]] })).toBeNull();
  });

  it("rejects accessor-backed and sparse response shapes without invoking code", () => {
    const choicesGetter = vi.fn(() => []);
    const bodyWithChoicesGetter = {};
    Object.defineProperty(bodyWithChoicesGetter, "choices", {
      get: choicesGetter,
    });
    expect(responseToolCallCount(bodyWithChoicesGetter)).toBeNull();
    expect(responseFinishReasonStatuses(bodyWithChoicesGetter)).toBeNull();
    expect(outputWasExactOk(bodyWithChoicesGetter)).toBeNull();
    expect(choicesGetter).not.toHaveBeenCalled();

    const sparseChoices = new Array(1);
    expect(responseToolCallCount({ choices: sparseChoices })).toBeNull();
    expect(responseFinishReasonStatuses({ choices: sparseChoices })).toBeNull();
    expect(outputWasExactOk({ choices: sparseChoices })).toBeNull();

    const messageGetter = vi.fn(() => ({ content: "OK" }));
    const choice = { finish_reason: "stop" };
    Object.defineProperty(choice, "message", { get: messageGetter });
    expect(responseToolCallCount({ choices: [choice] })).toBeNull();
    expect(outputWasExactOk({ choices: [choice] })).toBeNull();
    expect(messageGetter).not.toHaveBeenCalled();

    const contentGetter = vi.fn(() => "OK");
    const message = { tool_calls: null };
    Object.defineProperty(message, "content", { get: contentGetter });
    expect(
      outputWasExactOk({
        choices: [{ finish_reason: "stop", message }],
      })
    ).toBeNull();
    expect(contentGetter).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed usage aliases without invoking code", () => {
    const usageGetter = vi.fn(() => ({ prompt_tokens: 100 }));
    const body = {};
    Object.defineProperty(body, "usage", { get: usageGetter });
    expect(extractUsage(body)).toMatchObject({
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputTokens: null,
      usageFieldAudit: {
        cacheRead: "invalid",
        cacheWrite: "invalid",
        input: "invalid",
        output: "invalid",
        total: "invalid",
      },
    });
    expect(usageGetter).not.toHaveBeenCalled();

    const detailsGetter = vi.fn(() => ({ cached_tokens: 40 }));
    const usage = { prompt_tokens: 100 };
    Object.defineProperty(usage, "prompt_tokens_details", {
      get: detailsGetter,
    });
    expect(extractUsage({ usage })).toMatchObject({
      cacheReadSource: null,
      cacheReadTokens: null,
      inputSource: "prompt_tokens",
      inputTokens: 100,
      usageFieldAudit: { cacheRead: "invalid", input: "valid" },
    });
    expect(detailsGetter).not.toHaveBeenCalled();
  });

  it("sanitizes finish reasons and accepts only stop for zero-tool capture", () => {
    expect(ACCEPTED_ZERO_TOOL_FINISH_REASONS).toEqual(["stop"]);
    expect(
      responseFinishReasonStatuses({
        choices: [
          { finish_reason: "stop" },
          { finish_reason: "length" },
          { finish_reason: "content_filter" },
          { finish_reason: "function_call" },
          { finish_reason: "tool_calls" },
          {},
          { finish_reason: "provider-secret\nnonstandard" },
        ],
      })
    ).toEqual([
      "accepted-stop",
      "rejected-length",
      "rejected-content-filter",
      "rejected-function-call",
      "rejected-tool-calls",
      "missing",
      "invalid",
    ]);
    const getter = vi.fn(() => "stop");
    const choice = {};
    Object.defineProperty(choice, "finish_reason", { get: getter });
    expect(responseFinishReasonStatuses({ choices: [choice] })).toEqual([
      "invalid",
    ]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("sanitizes model ids and canonicalizes repeated trailing slashes", () => {
    expect(
      parseOptions([
        "--base-url",
        "https://example.test/v1///",
        "--models",
        "vendor/model-1",
      ])
    ).toMatchObject({
      baseUrl: "https://example.test/v1",
      models: ["vendor/model-1"],
    });
    expect(responseModel({ model: "vendor/model-1" })).toBe("vendor/model-1");
    expect(responseModel({ model: "vendor/model\nsecret" })).toBeNull();
    expect(() => parseOptions(["--models", "vendor/model\nsecret"])).toThrow(
      "safe model-id characters"
    );
    expect(() =>
      parseOptions(["--models", "vendor/model-1,vendor/model-1"])
    ).toThrow("duplicate model ids");
    expect(() => parseOptions(["--trials", "101"])).toThrow(
      "between 1 and 100"
    );
    expect(() => parseOptions(["--timeout-ms", "999"])).toThrow(
      "between 1000 and 600000"
    );
  });

  it("pins the verifier campaign and derives its exact request topology", () => {
    const options = parseOptions(["--evidence-campaign"]);

    expect(options).toMatchObject({
      baseUrl: EVIDENCE_CAMPAIGN.baseUrl,
      campaignId: EVIDENCE_CAMPAIGN.id,
      models: EVIDENCE_CAMPAIGN.models,
      prefixLines: EVIDENCE_CAMPAIGN.prefixLines,
      preflightModels: true,
      seed: EVIDENCE_CAMPAIGN.seed,
      settleMs: EVIDENCE_CAMPAIGN.settleMs,
      timeoutMs: EVIDENCE_CAMPAIGN.timeoutMs,
      trials: EVIDENCE_CAMPAIGN.trials,
    });
    expect(options.scenarios.map(({ name }) => name)).toEqual(
      EVIDENCE_CAMPAIGN.scenarios.map(({ name }) => name)
    );
    expect(EVIDENCE_CAMPAIGN_TOPOLOGY).toEqual({
      armsPerModel: 48,
      modelCount: 5,
      orderAssignmentCount: 120,
      pairOrderCount: 2,
      phasesPerArm: 2,
      requestsPerModel: 96,
      requestsPerScenario: {
        "active-set-change": 32,
        "membership-only-change": 32,
        "same-set-order": 32,
      },
      scenarioCount: 3,
      totalRequests: 480,
    });
    expect(() =>
      parseOptions(["--evidence-campaign", "--trials", "1"])
    ).toThrow("cannot be combined");
    expect(() =>
      parseOptions(["--skip-model-preflight", "--evidence-campaign"])
    ).toThrow("cannot be combined");
  });

  it("refuses to serialize credentials or bearer headers", () => {
    expect(() =>
      serializeBenchmarkResult(
        { echoed: "credential-value" },
        "credential-value"
      )
    ).toThrow("containing a credential");
    expect(() =>
      serializeBenchmarkResult({ echoed: "Bearer redacted" }, "different-key")
    ).toThrow("containing a credential");
  });

  it("excludes invalid cache counters from aggregation", () => {
    const audit = {
      cacheRead: "valid",
      cacheWrite: "absent",
      input: "valid",
      output: "absent",
      total: "absent",
    };
    expect(
      cacheMeasurementIsValid({
        cacheReadTokens: 101,
        cacheWriteTokens: null,
        inputTokens: 100,
        usageFieldAudit: audit,
      })
    ).toBe(false);
    expect(
      cacheMeasurementIsValid({
        cacheReadTokens: 50,
        cacheWriteTokens: -1,
        inputTokens: 100,
        usageFieldAudit: { ...audit, cacheWrite: "valid" },
      })
    ).toBe(false);
    expect(
      cacheMeasurementIsValid({
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        inputTokens: 100,
        usageFieldAudit: { ...audit, cacheWrite: "valid" },
      })
    ).toBe(true);
    expect(
      cacheMeasurementIsValid({
        cacheReadTokens: 70,
        cacheWriteTokens: 40,
        inputTokens: 100,
        usageFieldAudit: { ...audit, cacheWrite: "valid" },
      })
    ).toBe(false);
    expect(
      cacheMeasurementIsValid({
        cacheReadTokens: Number.MAX_SAFE_INTEGER,
        cacheWriteTokens: 1,
        inputTokens: Number.MAX_SAFE_INTEGER,
        usageFieldAudit: { ...audit, cacheWrite: "valid" },
      })
    ).toBe(false);
  });

  it("fails closed when individually safe token observations overflow an aggregate", () => {
    expect(() =>
      safeTokenSum([Number.MAX_SAFE_INTEGER, 1], "test sum")
    ).toThrow("exceeded the safe integer range");
    const request = {
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      cacheTelemetryEligible: true,
      cacheWriteTokens: null,
      inputTokens: Number.MAX_SAFE_INTEGER,
      latencyMs: 1,
      phase: "measure",
      success: true,
      usageFieldAudit: {
        cacheRead: "valid",
        cacheWrite: "absent",
        input: "valid",
        output: "absent",
        total: "absent",
      },
    };
    expect(() => variantSummary([request, request])).toThrow(
      "weighted cache-read tokens exceeded the safe integer range"
    );
  });

  it("produces a deterministic and exactly balanced AB/BA order", () => {
    const orders = Array.from({ length: 10 }, (_, index) =>
      pairOrderFor({
        model: "example/model",
        scenario: "same-set-order",
        seed: "methodology-test",
        trial: index + 1,
      })
    );

    expect(orders.filter((order) => order === "control-first")).toHaveLength(5);
    expect(orders.filter((order) => order === "changed-first")).toHaveLength(5);
    expect(orders).toEqual(
      Array.from({ length: 10 }, (_, index) =>
        pairOrderFor({
          model: "example/model",
          scenario: "same-set-order",
          seed: "methodology-test",
          trial: index + 1,
        })
      )
    );
  });

  it("uses unique equal-shape canaries and an equal-byte order swap", () => {
    const first = orderedTools(ALL_TOOL_NAMES, "a".repeat(24));
    const second = orderedTools(ALL_TOOL_NAMES, "b".repeat(24));
    const reversed = orderedTools(
      [...ALL_TOOL_NAMES].reverse(),
      "b".repeat(24)
    );

    expect(byteLength(first)).toBe(byteLength(second));
    expect(byteLength(second)).toBe(byteLength(reversed));
    expect(hash(first[0])).not.toBe(hash(second[0]));
    expect(Object.keys(first[0] ?? {})).toEqual(Object.keys(second[0] ?? {}));
  });

  it("derives request hashes from the campaign identity and exact wire body", () => {
    const identity = {
      model: "example/model",
      runId: "00000000-0000-4000-8000-000000000000",
      scenario: "same-set-order",
      trial: 1,
      variant: "stable-order",
    };
    const isolationToken = isolationTokenFor(identity);
    const first = benchmarkRequestArtifacts({
      isolationToken,
      model: identity.model,
      namespace: `cache-arm-${isolationToken}`,
      prefixLines: 2,
      toolNames: ALL_TOOL_NAMES,
    });
    const second = benchmarkRequestArtifacts({
      isolationToken,
      model: identity.model,
      namespace: `cache-arm-${isolationToken}`,
      prefixLines: 2,
      toolNames: ALL_TOOL_NAMES,
    });

    expect(isolationToken).toMatch(ISOLATION_TOKEN_PATTERN);
    expect(first).toEqual(second);
    expect(first.requestBodyBytes).toBe(Buffer.byteLength(first.requestBody));
    expect(first.requestBodySha256).toBe(hashText(first.requestBody));
    expect(JSON.parse(first.requestBody)).not.toHaveProperty("tool_choice");
  });

  it("keeps membership-only arms equal in tool count and serialized bytes", () => {
    const control = MEMBERSHIP_SCENARIO.arms.find(
      ({ variant }) => variant === MEMBERSHIP_SCENARIO.controlVariant
    );
    const changed = MEMBERSHIP_SCENARIO.arms.find(
      ({ variant }) => variant === MEMBERSHIP_SCENARIO.changedVariant
    );
    expect(control).toBeDefined();
    expect(changed).toBeDefined();
    const token = "c".repeat(24);
    const controlTools = orderedTools(control.measuredTools, token);
    const changedTools = orderedTools(changed.measuredTools, token);

    expect(controlTools).toHaveLength(changedTools.length);
    expect(byteLength(controlTools)).toBe(byteLength(changedTools));
    expect(hash(controlTools)).not.toBe(hash(changedTools));
  });

  it("runs the first-response and write path end to end with synthetic fetch", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "pss-cache-benchmark-")
    );
    const output = join(temporaryDirectory, "synthetic.json");
    let chatResponseIndex = 0;
    const fetchMock = vi.fn((input, init) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer synthetic-control-key"
      );
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "synthetic/model" }] }),
          { headers: { "content-type": "application/json" }, status: 200 }
        );
      }
      expect(url).toBe("https://synthetic.invalid/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const requestBody = JSON.parse(String(init?.body));
      expect(requestBody.model).toBe("synthetic/model");
      chatResponseIndex += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OK", role: "assistant", tool_calls: null },
            },
          ],
          id: `synthetic-response-${chatResponseIndex}`,
          model: "synthetic/model",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 100,
            prompt_tokens_details: {
              cache_write_tokens: 10,
              cached_tokens: 50,
            },
            total_tokens: 101,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const options = parseOptions([
        "--base-url",
        "https://synthetic.invalid/v1",
        "--models",
        "synthetic/model",
        "--output",
        output,
        "--prefix-lines",
        "1",
        "--scenario-set",
        "membership-only",
        "--seed",
        "synthetic-control",
        "--settle-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--trials",
        "1",
      ]);
      const result = await runBenchmark(options, "synthetic-control-key");
      const serialized = await readFile(output, "utf8");
      const written = JSON.parse(serialized);

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(chatResponseIndex).toBe(4);
      expect(written).toEqual(result);
      expect(written).toMatchObject({
        credentialRecorded: false,
        schemaVersion: 3,
        configuration: {
          campaignId: null,
          requestTopology: {
            armsPerModel: 2,
            modelCount: 1,
            requestsPerModel: 4,
            totalRequests: 4,
          },
        },
      });
      expect(written.models[0].requests).toHaveLength(4);
      expect(
        written.models[0].requests.map(({ requestSequence }) => requestSequence)
      ).toEqual([1, 2, 3, 4]);
      expect(
        written.models[0].requests.every(
          ({ cacheTelemetryEligible }) => cacheTelemetryEligible
        )
      ).toBe(true);
      expect(
        written.models[0].requests.map(
          ({ responseFinishReasonStatuses }) => responseFinishReasonStatuses
        )
      ).toEqual([
        ["accepted-stop"],
        ["accepted-stop"],
        ["accepted-stop"],
        ["accepted-stop"],
      ]);
      expect(written.models[0].finishReasonAudit.all).toMatchObject({
        acceptedResponses: 4,
        choicesAudited: 4,
        responseShapeUnavailable: 0,
        responses: 4,
      });
      expect((await stat(output)).mode % 0o1000).toBe(0o600);
      expect(serialized).not.toContain("synthetic-control-key");
    } finally {
      vi.unstubAllGlobals();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("fails closed on missing and nonstandard finish reasons, including warmup eligibility", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "pss-cache-benchmark-finish-reason-")
    );
    const output = join(temporaryDirectory, "synthetic.json");
    const finishReasons = [
      undefined,
      "stop",
      "provider-secret-nonstandard",
      "stop",
    ];
    let chatResponseIndex = 0;
    const fetchMock = vi.fn((input) => {
      if (String(input).endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "synthetic/model" }] }),
          { headers: { "content-type": "application/json" }, status: 200 }
        );
      }
      const finishReason = finishReasons[chatResponseIndex];
      chatResponseIndex += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              ...(finishReason === undefined
                ? {}
                : { finish_reason: finishReason }),
              message: { content: "OK", role: "assistant", tool_calls: null },
            },
          ],
          model: "synthetic/model",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 100,
            prompt_tokens_details: { cached_tokens: 50 },
            total_tokens: 101,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const options = parseOptions([
        "--base-url",
        "https://synthetic.invalid/v1",
        "--models",
        "synthetic/model",
        "--output",
        output,
        "--prefix-lines",
        "1",
        "--scenario-set",
        "membership-only",
        "--seed",
        "synthetic-finish-reason",
        "--settle-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--trials",
        "1",
      ]);
      const result = await runBenchmark(options, "synthetic-control-key");
      const serialized = await readFile(output, "utf8");
      const requests = result.models[0].requests;

      expect(requests.map(({ success }) => success)).toEqual([
        false,
        true,
        false,
        true,
      ]);
      expect(
        requests.map(
          ({ responseFinishReasonStatuses }) => responseFinishReasonStatuses
        )
      ).toEqual([
        ["missing"],
        ["accepted-stop"],
        ["invalid"],
        ["accepted-stop"],
      ]);
      expect(requests.map(({ errorCode }) => errorCode)).toEqual([
        "invalid-finish-reason",
        null,
        "invalid-finish-reason",
        null,
      ]);
      expect(
        requests
          .filter(({ phase }) => phase === "measure")
          .map(({ cacheTelemetryEligible, warmupPrerequisitePassed }) => ({
            cacheTelemetryEligible,
            warmupPrerequisitePassed,
          }))
      ).toEqual([
        { cacheTelemetryEligible: false, warmupPrerequisitePassed: false },
        { cacheTelemetryEligible: false, warmupPrerequisitePassed: false },
      ]);
      expect(result.models[0].requestOutcomeAudit.invalidFinishReason).toBe(2);
      expect(serialized).not.toContain("provider-secret-nonstandard");
    } finally {
      vi.unstubAllGlobals();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("requires one exact OK choice for capture and warmup eligibility", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "pss-cache-benchmark-output-shape-")
    );
    const output = join(temporaryDirectory, "synthetic.json");
    const responseChoices = [
      [
        {
          finish_reason: "stop",
          message: { content: "NOT OK", role: "assistant", tool_calls: null },
        },
      ],
      [
        {
          finish_reason: "stop",
          message: { content: "OK", role: "assistant", tool_calls: null },
        },
      ],
      [
        {
          finish_reason: "stop",
          message: { content: "OK", role: "assistant", tool_calls: null },
        },
        {
          finish_reason: "stop",
          message: { content: "OK", role: "assistant", tool_calls: null },
        },
      ],
      [
        {
          finish_reason: "stop",
          message: { content: " OK ", role: "assistant", tool_calls: null },
        },
      ],
    ];
    let chatResponseIndex = 0;
    const fetchMock = vi.fn((input) => {
      if (String(input).endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "synthetic/model" }] }),
          { headers: { "content-type": "application/json" }, status: 200 }
        );
      }
      const choices = responseChoices[chatResponseIndex];
      chatResponseIndex += 1;
      return new Response(
        JSON.stringify({
          choices,
          model: "synthetic/model",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 100,
            prompt_tokens_details: { cached_tokens: 50 },
            total_tokens: 101,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const options = parseOptions([
        "--base-url",
        "https://synthetic.invalid/v1",
        "--models",
        "synthetic/model",
        "--output",
        output,
        "--prefix-lines",
        "1",
        "--scenario-set",
        "membership-only",
        "--seed",
        "synthetic-output-shape",
        "--settle-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--trials",
        "1",
      ]);
      const result = await runBenchmark(options, "synthetic-control-key");
      const requests = result.models[0].requests;

      expect(requests.map(({ outputWasExactOk }) => outputWasExactOk)).toEqual([
        false,
        true,
        null,
        true,
      ]);
      expect(requests.map(({ errorCode }) => errorCode)).toEqual([
        "unexpected-output",
        null,
        "invalid-response-shape",
        null,
      ]);
      expect(requests.map(({ success }) => success)).toEqual([
        false,
        true,
        false,
        true,
      ]);
      expect(result.models[0].requestOutcomeAudit).toMatchObject({
        invalidResponseShape: 1,
        unexpectedOutput: 1,
      });
      expect(
        requests
          .filter(({ phase }) => phase === "measure")
          .map(({ cacheTelemetryEligible, warmupPrerequisitePassed }) => ({
            cacheTelemetryEligible,
            warmupPrerequisitePassed,
          }))
      ).toEqual([
        { cacheTelemetryEligible: false, warmupPrerequisitePassed: false },
        { cacheTelemetryEligible: false, warmupPrerequisitePassed: false },
      ]);
    } finally {
      vi.unstubAllGlobals();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("refuses to write when a synthetic end-of-run source rehash drifts", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "pss-cache-benchmark-drift-")
    );
    const output = join(temporaryDirectory, "must-not-exist.json");
    const fetchMock = vi.fn((input) => {
      if (String(input).endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "synthetic/model" }] }),
          { headers: { "content-type": "application/json" }, status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OK", role: "assistant", tool_calls: null },
            },
          ],
          model: "synthetic/model",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 100,
            prompt_tokens_details: { cached_tokens: 50 },
            total_tokens: 101,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    });
    const sourceSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        benchmarkSourceSha256: "a".repeat(64),
        implementationSourcesSha256: { "source.ts": "b".repeat(64) },
      })
      .mockResolvedValueOnce({
        benchmarkSourceSha256: "c".repeat(64),
        implementationSourcesSha256: { "source.ts": "b".repeat(64) },
      });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const options = parseOptions([
        "--base-url",
        "https://synthetic.invalid/v1",
        "--models",
        "synthetic/model",
        "--output",
        output,
        "--prefix-lines",
        "1",
        "--scenario-set",
        "membership-only",
        "--seed",
        "synthetic-drift",
        "--settle-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--trials",
        "1",
      ]);

      await expect(
        runBenchmark(options, "synthetic-control-key", { sourceSnapshot })
      ).rejects.toThrow("sources changed during the campaign");
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(sourceSnapshot).toHaveBeenCalledTimes(2);
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllGlobals();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}
