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
          orderedToolNamesFingerprint: namesFingerprint(wireNames),
          registeredToolCount: CANONICAL_TOOL_NAMES.length,
          registryToolNamesFingerprint: namesFingerprint(
            [...CANONICAL_TOOL_NAMES].sort(compareToolNames)
          ),
          runtimeStepIndex,
        });
      }
    }

    expect(reverse.requests.map((request) => request.toolsArraySha256)).toEqual(
      forward.requests.map((request) => request.toolsArraySha256)
    );
    expect(forward.requests[0]?.toolsArraySha256).not.toBe(
      forward.requests[1]?.toolsArraySha256
    );
    expect(forward.requests.length + reverse.requests.length).toBe(4);
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
