import { describe, expect, it } from "vitest";
import {
  type CloudflareAgentsDurableObjectContext,
  type CloudflareAgentsFiberContext,
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsSchedule,
  type CloudflareAgentsScheduleOptions,
  type CloudflareAgentsStartFiberOptions,
  type CloudflareAgentsStartFiberResult,
  createCloudflareAgentsExecutionHost,
} from "./index";
import { createFakeCloudflareAgent } from "./test-support";

describe("Cloudflare Agents SDK shape", () => {
  it("accepts a subclass shape with protected ctx", async () => {
    const cloudflareAgent = new AgentsSdkShapeFixture();
    const host = cloudflareAgent.createPssRuntimeHost();

    await host.scheduler.enqueueRun("background:bg_sdk_shape");

    expect(cloudflareAgent.startedFiberNames).toEqual([
      "pss-runtime:resume-run",
    ]);
    expect(cloudflareAgent.scheduledCallbacks).toEqual([]);
  });
});

class AgentsSdkShapeFixture {
  protected readonly ctx: CloudflareAgentsDurableObjectContext =
    createFakeCloudflareAgent().durableObjectContext;
  readonly scheduledCallbacks: string[] = [];
  readonly startedFiberNames: string[] = [];

  createPssRuntimeHost() {
    return createCloudflareAgentsExecutionHost({
      cloudflareAgent: this,
      durableObjectContext: this.ctx,
      prefix: "tenant-a",
      resume: () => Promise.resolve(null),
    });
  }

  resumePssRuntimeFiber(_payload: unknown): Promise<void> {
    return Promise.resolve();
  }

  schedule<TPayload extends CloudflareAgentsFiberPayload>(
    _when: Date | number | string,
    callback: keyof this,
    payload: TPayload,
    _options?: CloudflareAgentsScheduleOptions
  ): Promise<CloudflareAgentsSchedule<TPayload>> {
    this.scheduledCallbacks.push(String(callback));
    return Promise.resolve({
      callback: String(callback),
      id: `schedule-${this.scheduledCallbacks.length}`,
      payload,
      type: "delayed",
    });
  }

  async startFiber(
    name: string,
    fn: (ctx: CloudflareAgentsFiberContext) => Promise<void>,
    _options?: CloudflareAgentsStartFiberOptions
  ): Promise<CloudflareAgentsStartFiberResult> {
    await fn({
      id: `fiber-${this.startedFiberNames.length + 1}`,
      signal: new AbortController().signal,
      snapshot: null,
      stash: () => undefined,
    });
    this.startedFiberNames.push(name);
    return { accepted: true, status: "completed" };
  }
}
