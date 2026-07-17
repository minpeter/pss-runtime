import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  benchmarkRequestArtifacts,
  EVIDENCE_CAMPAIGN,
  EVIDENCE_CAMPAIGN_TOPOLOGY,
  IMPLEMENTATION_SOURCE_PATHS,
  isolationTokenFor,
} from "./benchmark-cache-stable-tools.mts";
import {
  EXPECTED_CAMPAIGN_ID,
  EXPECTED_MODELS,
  verifyEvidenceDocument,
} from "./cache-stable-tools-independent-verifier.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE_PATH = resolve(
  REPOSITORY_ROOT,
  "benchmarks/cache-stable-tools/latest-freerouter.json"
);
const PROBE_PATH = resolve(
  REPOSITORY_ROOT,
  "benchmarks/cache-stable-tools/mistral-response-shape-probe.json"
);
const RUNNER_PATH = resolve(
  REPOSITORY_ROOT,
  "scripts/benchmark-cache-stable-tools.mts"
);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const BEARER_PATTERN = /Bearer\s/iu;
const KEY_LIKE_PATTERN = /\bfr-[\w-]{8,}\b/u;

describe("checked-in cache-stable tool evidence", () => {
  it("binds the live snapshot to the producer and independent verifier", async () => {
    const serialized = await readFile(EVIDENCE_PATH, "utf8");
    const evidence = JSON.parse(serialized);

    expect(evidence).toMatchObject({
      credentialRecorded: false,
      endpoint: EVIDENCE_CAMPAIGN.baseUrl,
      protocol: "openai-chat-completions",
      schemaVersion: 3,
      configuration: {
        campaignId: EXPECTED_CAMPAIGN_ID,
        minimumOrderStratumCoverage: 1,
        models: EXPECTED_MODELS,
        responseBodyLimits: {
          chatCompletionsBytes: 1_000_000,
          modelCatalogBytes: 5_000_000,
        },
        sourceWorktreeCleanAtStart: true,
      },
    });
    expect(evidence.configuration.sourceFreezeCommitSha).toMatch(
      GIT_COMMIT_PATTERN
    );
    expect(evidence.configuration.requestTopology).toEqual(
      EVIDENCE_CAMPAIGN_TOPOLOGY
    );
    expect(evidence.configuration.benchmarkSourceSha256).toBe(
      sha256(await readFile(RUNNER_PATH))
    );
    expect(
      Object.keys(evidence.configuration.implementationSourcesSha256)
    ).toEqual([...IMPLEMENTATION_SOURCE_PATHS]);
    for (const sourcePath of IMPLEMENTATION_SOURCE_PATHS) {
      expect(
        evidence.configuration.implementationSourcesSha256[sourcePath]
      ).toBe(sha256(await readFile(resolve(REPOSITORY_ROOT, sourcePath))));
    }

    const verified = await verifyEvidenceDocument({
      serialized,
      repoRoot: REPOSITORY_ROOT,
    });
    expect(verified.report.aggregate).toMatchObject({
      expectedRequests: EVIDENCE_CAMPAIGN_TOPOLOGY.totalRequests,
      observedRequests: EVIDENCE_CAMPAIGN_TOPOLOGY.totalRequests,
    });
    expect(verified.evidenceSha256).toBe(sha256(serialized));

    const requests = evidence.models.flatMap((model) =>
      model.requests.map((request) => ({ model: model.model, request }))
    );
    expect(requests).toHaveLength(EVIDENCE_CAMPAIGN_TOPOLOGY.totalRequests);
    for (const { model, request } of requests) {
      const scenario = EVIDENCE_CAMPAIGN.scenarios.find(
        ({ name }) => name === request.scenario
      );
      const arm = scenario?.arms.find(
        ({ variant }) => variant === request.variant
      );
      expect(scenario).toBeDefined();
      expect(arm).toBeDefined();
      const isolationToken = isolationTokenFor({
        armPosition: request.armPosition,
        model,
        runId: evidence.configuration.runId,
        scenario: request.scenario,
        trial: request.trial,
      });
      const artifacts = benchmarkRequestArtifacts({
        isolationToken,
        model,
        namespace: `cache-arm-${isolationToken}`,
        prefixLines: evidence.configuration.prefixLines,
        toolNames:
          request.phase === "warmup" ? scenario.warmupTools : arm.measuredTools,
      });
      expect(request).toMatchObject({
        isolationCanarySha256: artifacts.isolationCanarySha256,
        requestBodyBytes: artifacts.requestBodyBytes,
        requestBodySha256: artifacts.requestBodySha256,
        toolsArrayBytes: artifacts.toolsArrayBytes,
        toolsArraySha256: artifacts.toolsArraySha256,
      });
      for (const field of ["serviceTierSha256", "systemFingerprintSha256"]) {
        expect(
          request[field] === null || HASH_PATTERN.test(request[field])
        ).toBe(true);
      }
    }

    expect(serialized).not.toMatch(BEARER_PATTERN);
    expect(serialized).not.toMatch(KEY_LIKE_PATTERN);
  });

  it("keeps the parser-discovery probe shape-only and credential-free", async () => {
    const serialized = await readFile(PROBE_PATH, "utf8");
    const probe = JSON.parse(serialized);

    expect(probe).toMatchObject({
      credentialRecorded: false,
      endpoint: EVIDENCE_CAMPAIGN.baseUrl,
      protocol: "openai-chat-completions",
    });
    expect(probe.responseShape).toEqual(
      expect.objectContaining({
        content: expect.objectContaining({ present: expect.any(Boolean) }),
        toolCalls: expect.objectContaining({ present: expect.any(Boolean) }),
        usage: expect.objectContaining({ present: expect.any(Boolean) }),
      })
    );
    expect(serialized).not.toMatch(BEARER_PATTERN);
    expect(serialized).not.toMatch(KEY_LIKE_PATTERN);
  });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
