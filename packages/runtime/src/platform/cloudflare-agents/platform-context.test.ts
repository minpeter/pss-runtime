import { describe, expect, it } from "vitest";
import {
  type CloudflareAgentsResumeRun,
  createCloudflareAgentsPlatformContext,
} from "./index";
import { createFakeCloudflareAgent } from "./test-support";

describe("Cloudflare Agents platform context", () => {
  it("resumes delayed callbacks with an allowed scheduled payload prefix", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const prefixes: string[] = [];
    const runIds: string[] = [];
    const resume: CloudflareAgentsResumeRun = (payload) => {
      prefixes.push(payload.prefix);
      runIds.push(payload.runId);
      return Promise.resolve(null);
    };
    const context = createCloudflareAgentsPlatformContext({
      cloudflareAgent,
      createAgent: ({ host, prefix }) => ({
        host,
        prefix,
        resume: (runId: string) =>
          resume({
            kind: "run",
            prefix,
            runId,
            version: 1,
          }),
      }),
      allowedPrefixes: ["scheduled-prefix"],
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });

    await context.resumeScheduledFiber({
      kind: "run",
      prefix: "scheduled-prefix",
      runId: "background:bg_scheduled",
      version: 1,
    });

    expect(prefixes).toEqual(["scheduled-prefix"]);
    expect(runIds).toEqual(["background:bg_scheduled"]);
    expect(cloudflareAgent.started).toEqual([
      {
        idempotencyKey:
          "pss-runtime:scheduled-prefix:run:background:bg_scheduled",
        name: "pss-runtime:resume-run",
        snapshot: {
          kind: "run",
          prefix: "scheduled-prefix",
          runId: "background:bg_scheduled",
          version: 1,
        },
      },
    ]);
  });

  it("rejects delayed callbacks outside the allowed prefix set", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const context = createCloudflareAgentsPlatformContext({
      cloudflareAgent,
      createAgent: ({ prefix }) => ({
        prefix,
        resume: (runId: string) => {
          resumed.push(`${prefix}:${runId}`);
          return Promise.resolve(null);
        },
      }),
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });

    const result = await context.resumeScheduledFiber({
      kind: "run",
      prefix: "scheduled-prefix",
      runId: "background:bg_blocked",
      version: 1,
    });

    expect(result).toMatchObject({
      accepted: false,
      status: "aborted",
    });
    expect(resumed).toEqual([]);
    expect(cloudflareAgent.started).toEqual([]);
  });

  it("uses allowPrefix to authorize multi-prefix delayed callbacks", async () => {
    const cloudflareAgent = createFakeCloudflareAgent();
    const resumed: string[] = [];
    const context = createCloudflareAgentsPlatformContext({
      allowPrefix: ({ prefix }) => prefix.startsWith("tenant-"),
      cloudflareAgent,
      createAgent: ({ prefix }) => ({
        prefix,
        resume: (runId: string) => {
          resumed.push(`${prefix}:${runId}`);
          return Promise.resolve(null);
        },
      }),
      defaultPrefix: "current-prefix",
      durableObjectContext: cloudflareAgent.durableObjectContext,
      env: {},
    });

    await expect(
      context.resumeScheduledFiber({
        kind: "run",
        prefix: "tenant-a",
        runId: "background:bg_allowed",
        version: 1,
      })
    ).resolves.toMatchObject({
      accepted: true,
      status: "completed",
    });
    expect(resumed).toEqual(["tenant-a:background:bg_allowed"]);
  });
});
