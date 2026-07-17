import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const runnerUrl = new URL(
  "./broad-context-cache-benchmark.mjs",
  import.meta.url
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const modelId = "minimaxai/minimax-m2.7";
const apiRoot = "https://benchmark.invalid/v1";

const fetchMockSource = `
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === "${apiRoot}/models") {
    return Response.json({ data: [{ id: "${modelId}" }] });
  }
  if (url === "${apiRoot}/chat/completions") {
    const body = JSON.parse(init.body);
    if (body.model !== "${modelId}") {
      throw new Error("unexpected model");
    }
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              evidence: "DECISION-ORION-000",
              value: "owner-amber",
            }),
          },
        },
      ],
      model: "${modelId}",
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: {
          cache_creation_tokens: 125,
          cached_tokens: 750,
        },
      },
    });
  }
  throw new Error(\`unexpected fetch: \${url}\`);
};
`;
const fetchMockUrl = `data:text/javascript,${encodeURIComponent(fetchMockSource)}`;

describe("broad-context cache benchmark live flow", () => {
  it("extracts usage through a synthetic no-network campaign after source initialization", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        fetchMockUrl,
        fileURLToPath(runnerUrl),
        "conversation",
        repoRoot,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FREEROUTER_API_KEY: "synthetic-live-flow-test",
          FREEROUTER_BASE_URL: apiRoot,
          PSS_LIVE_CHUNK_CHARACTERS: "1",
          PSS_LIVE_CONFIRMATION: "",
          PSS_LIVE_FIXTURE_ONLY: "",
          PSS_LIVE_HIGH_WATER_TOKENS: "100",
          PSS_LIVE_MINIMAX_MAX_OUTPUT_TOKENS: "16",
          PSS_LIVE_MODELS: modelId,
          PSS_LIVE_POLICIES: "high-water-stable-prefix",
          PSS_LIVE_STEPS: "1",
        },
        maxBuffer: 1_000_000,
        timeout: 30_000,
      }
    );
    const report = JSON.parse(output);
    const turn = report.runs[0]?.turns[0];

    assert.equal(report.endpoint, apiRoot);
    assert.equal(report.modelCatalog.status, "passed");
    assert.equal(report.credentialRecorded, false);
    assert.deepEqual(
      {
        cacheWriteTokens: turn?.cacheWriteTokens,
        cachedTokens: turn?.cachedTokens,
        inputTokens: turn?.inputTokens,
        usageEnvelopeValid: turn?.usageEnvelopeValid,
        usageFieldAudit: turn?.usageFieldAudit,
      },
      {
        cacheWriteTokens: 125,
        cachedTokens: 750,
        inputTokens: 1000,
        usageEnvelopeValid: true,
        usageFieldAudit: {
          cacheRead: "valid",
          cacheWrite: "valid",
          input: "valid",
        },
      }
    );

    const expectedFiles = report.benchmarkSource.files.map(({ path }) => ({
      path,
      sha256: sha256(readFileSync(new URL(path, runnerUrl))),
    }));
    assert.deepEqual(report.benchmarkSource.files, expectedFiles);
    assert.equal(
      report.benchmarkSource.manifestSha256,
      sha256(JSON.stringify(expectedFiles))
    );
  });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
