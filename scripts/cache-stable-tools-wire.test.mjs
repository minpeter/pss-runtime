import { createHash } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../packages/runtime/src/index.ts";
import { createInMemoryHost } from "../packages/runtime/src/platform/memory/index.ts";

const FIXED_TOOL_NAMES = [
  "runtime_status",
  "read_project_file",
  "list_project_files",
  "search_project_text",
];
const DYNAMIC_TOOL_NAMES = [
  "query_issue_tracker",
  "query_release_notes",
  "query_session_memory",
  "query_dependency_docs",
];
const CANONICAL_TOOL_NAMES = [...FIXED_TOOL_NAMES, ...DYNAMIC_TOOL_NAMES];
const CHANGED_TOOL_NAMES = [
  ...FIXED_TOOL_NAMES,
  ...DYNAMIC_TOOL_NAMES.slice(0, 2),
];
const EXPECTED_ORDERED_FINGERPRINTS = [
  "sha256:f7d997c1233bcac1eefa0f5ef285bb050a086df298aa31befe430850e38a8492",
  "sha256:824af4663a8abe6226db9c1ad6965d5184280b568b1ccce136f3254bb03c80d3",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const EMPTY_INPUT_SCHEMA = z.object({});
const TOOL_DEFINITIONS = Object.fromEntries(
  CANONICAL_TOOL_NAMES.map((name) => [
    name,
    {
      description: `Deterministic wire-order smoke tool: ${name}.`,
      execute: () => ({ ok: true }),
      inputSchema: EMPTY_INPUT_SCHEMA,
    },
  ])
);

describe("cache-stable tool wire order", () => {
  it("keeps canonical PSS order independent of registry insertion order", async () => {
    const forward = await runWireScenario(CANONICAL_TOOL_NAMES);
    const reverse = await runWireScenario([...CANONICAL_TOOL_NAMES].reverse());
    const expectedWireNames = [CANONICAL_TOOL_NAMES, CHANGED_TOOL_NAMES];

    for (const result of [forward, reverse]) {
      expect(result.preparedStepIndices).toEqual([0, 1]);
      expect(result.requests.map((request) => request.toolNames)).toEqual(
        expectedWireNames
      );
      expect(result.requests).toHaveLength(2);
      expect(result.diagnostics).toHaveLength(2);
      expect(
        result.diagnostics.map(
          (diagnostic) => diagnostic.orderedToolNamesFingerprint
        )
      ).toEqual(EXPECTED_ORDERED_FINGERPRINTS);

      for (const [runtimeStepIndex, wireNames] of expectedWireNames.entries()) {
        expect(result.diagnostics[runtimeStepIndex]).toEqual({
          activeToolCount: wireNames.length,
          activeToolsFingerprint: namesFingerprint(
            [...wireNames].sort(compareToolNames)
          ),
          alwaysActiveToolCount: FIXED_TOOL_NAMES.length,
          attemptId: expect.stringMatching(UUID_PATTERN),
          dynamicDescriptionToolCount: 0,
          modelIdentityFingerprint: expect.stringMatching(SHA256_PATTERN),
          modelIdentityFingerprintUnavailable: true,
          orderedToolSemanticFingerprint: expect.stringMatching(SHA256_PATTERN),
          orderedToolNamesFingerprint: namesFingerprint(wireNames),
          registeredToolCount: CANONICAL_TOOL_NAMES.length,
          registryToolNamesFingerprint: namesFingerprint(
            [...CANONICAL_TOOL_NAMES].sort(compareToolNames)
          ),
          runtimeStepIndex,
          selectionDurationMs: expect.any(Number),
          semanticFingerprintUnavailableToolCount: 0,
          toolLoadingStrategy: "eager-active-tools",
        });
      }
      expect(
        new Set(result.diagnostics.map((diagnostic) => diagnostic.attemptId))
          .size
      ).toBe(2);
      for (const diagnostic of result.diagnostics) {
        expect(Number.isFinite(diagnostic.selectionDurationMs)).toBe(true);
        expect(diagnostic.selectionDurationMs).toBeGreaterThanOrEqual(0);
      }
    }

    expect(reverse.requests.map((request) => request.toolsArraySha256)).toEqual(
      forward.requests.map((request) => request.toolsArraySha256)
    );
    expect(
      reverse.diagnostics.map(
        (diagnostic) => diagnostic.orderedToolSemanticFingerprint
      )
    ).toEqual(
      forward.diagnostics.map(
        (diagnostic) => diagnostic.orderedToolSemanticFingerprint
      )
    );
    expect(forward.requests[0]?.toolsArraySha256).not.toBe(
      forward.requests[1]?.toolsArraySha256
    );
    expect(forward.requests.length + reverse.requests.length).toBe(4);
  });

  it("keeps OpenAI-specific deferral hints eager on the generic compatible adapter", async () => {
    let capturedBody;
    const provider = createOpenAICompatible({
      baseURL: "https://wire.invalid/v1",
      fetch: (input, init) => {
        expect(String(input)).toBe("https://wire.invalid/v1/chat/completions");
        capturedBody = parseRequestBody(init?.body);
        return Promise.resolve(
          new Response(JSON.stringify(syntheticResponse(1)), {
            headers: { "content-type": "application/json" },
            status: 200,
          })
        );
      },
      name: "generic-compatible-negative-canary",
    });
    const agent = await createAgent({
      model: provider("generic-compatible-model"),
      prepareModelStep: () => ({ activeTools: ["deferred_candidate"] }),
      tools: {
        deferred_candidate: {
          description: "A candidate carrying an OpenAI-only deferral hint.",
          execute: () => ({ ok: true }),
          inputSchema: EMPTY_INPUT_SCHEMA,
          providerOptions: { openai: { deferLoading: true } },
        },
        inactive_candidate: {
          description: "This inactive tool must not reach the wire.",
          execute: () => ({ ok: true }),
          inputSchema: EMPTY_INPUT_SCHEMA,
        },
      },
    });

    try {
      const turn = await agent.send("Return DONE without calling a tool.");
      for await (const _event of turn.events()) {
        // Drain the single synthetic model step.
      }
    } finally {
      await agent.dispose();
    }

    const wireTools = requireWireTools(capturedBody?.tools);
    expect(wireTools.map((entry) => entry.function.name)).toEqual([
      "deferred_candidate",
    ]);
    const serialized = JSON.stringify(capturedBody);
    expect(serialized).not.toContain("defer_loading");
    expect(serialized).not.toContain("tool_search");
    expect(serialized).not.toContain("additional_tools");
    expect(serialized).not.toContain("inactive_candidate");
  });
});

async function runWireScenario(registryOrder) {
  const requests = [];
  const diagnostics = [];
  const preparedStepIndices = [];
  let responseIndex = 0;
  const provider = createOpenAICompatible({
    baseURL: "https://wire.invalid/v1",
    fetch: (input, init) => {
      expect(String(input)).toBe("https://wire.invalid/v1/chat/completions");
      const body = parseRequestBody(init?.body);
      const wireTools = requireWireTools(body.tools);
      requests.push({
        toolNames: wireTools.map((entry) => entry.function.name),
        toolsArraySha256: sha256Hex(JSON.stringify(wireTools)),
      });
      const response = syntheticResponse(responseIndex);
      responseIndex += 1;
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      );
    },
    name: "wire-smoke",
  });
  const baseHost = createInMemoryHost();
  const host = {
    ...baseHost,
    diagnostics: {
      report: (diagnostic) => {
        if (
          diagnostic.code === "model.tool_cache_fingerprint" &&
          diagnostic.metadata
        ) {
          diagnostics.push(diagnostic.metadata);
        }
      },
    },
  };
  const agent = await createAgent({
    alwaysActiveTools: [...FIXED_TOOL_NAMES].reverse(),
    host,
    model: provider("wire-smoke-model"),
    prepareModelStep: ({ runtimeStepIndex }) => {
      preparedStepIndices.push(runtimeStepIndex);
      return {
        activeTools:
          runtimeStepIndex === 0
            ? [...DYNAMIC_TOOL_NAMES].reverse()
            : DYNAMIC_TOOL_NAMES.slice(0, 2).reverse(),
      };
    },
    toolOrder: CANONICAL_TOOL_NAMES,
    tools: registryFor(registryOrder),
  });

  try {
    const turn = await agent.send("Run the deterministic wire-order smoke.");
    for await (const _event of turn.events()) {
      // Draining the event stream runs both model steps and the synthetic tool.
    }
    await vi.waitFor(() => expect(diagnostics).toHaveLength(2));
  } finally {
    await agent.dispose();
  }

  return {
    diagnostics: [...diagnostics].sort(
      (left, right) => left.runtimeStepIndex - right.runtimeStepIndex
    ),
    preparedStepIndices,
    requests,
  };
}

function registryFor(order) {
  return Object.fromEntries(
    order.map((name) => {
      const definition = TOOL_DEFINITIONS[name];
      if (!definition) {
        throw new TypeError(`Unknown smoke tool: ${name}`);
      }
      return [name, definition];
    })
  );
}

function syntheticResponse(index) {
  if (index === 0) {
    return {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: "{}",
                  name: "runtime_status",
                },
                id: "call_runtime_status",
                type: "function",
              },
            ],
          },
        },
      ],
      model: "wire-smoke-model",
    };
  }
  return {
    choices: [
      {
        finish_reason: "stop",
        message: { content: "DONE", role: "assistant" },
      },
    ],
    model: "wire-smoke-model",
  };
}

function parseRequestBody(body) {
  if (typeof body !== "string") {
    throw new TypeError("Expected the OpenAI-compatible request body as JSON.");
  }
  const parsed = JSON.parse(body);
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new TypeError("Expected an object request body.");
  }
  return parsed;
}

function requireWireTools(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected a tools array at the custom fetch boundary.");
  }
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !entry.function ||
      typeof entry.function !== "object" ||
      typeof entry.function.name !== "string"
    ) {
      throw new TypeError("Expected OpenAI-compatible function tools.");
    }
  }
  return value;
}

function namesFingerprint(names) {
  return `sha256:${sha256Hex(JSON.stringify(names))}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareToolNames(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
