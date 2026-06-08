import {
  ackScheduledCloudflareRun,
  createCloudflareDurableObjectHost,
  drainAgentRun,
  drainCloudflareAlarm,
  listScheduledCloudflareRuns,
} from "@minpeter/pss-runtime/cloudflare";
import { createWorkerCoordinator } from "../agent/factory";
import { FailingRunLookupStorage } from "../cloudflare/failing-run-lookup-storage";
import type { RunStressScenarioOptions } from ".";
import { type StressScenarioResult, scenarioResult } from "./result";

export async function runDuplicateAlarmScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const host = createCloudflareDurableObjectHost({
    prefix: options.route.storePrefix,
    storage: options.storage,
  });
  await host.scheduler.enqueueRun("background:bg_duplicate");
  await host.scheduler.enqueueRun("background:bg_duplicate");
  await ackScheduledCloudflareRun(options.storage, "background:bg_duplicate", {
    prefix: options.route.storePrefix,
  });
  return scenarioResult(
    "duplicate-alarm",
    [],
    ["scenario:duplicate-alarm", "duplicate:deduped"],
    undefined,
    options.request.stress.summaryEvents
  );
}

export async function runResumeRetryScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const runId = "background:bg_retry";
  const host = createCloudflareDurableObjectHost({
    prefix: options.route.storePrefix,
    storage: options.storage,
  });
  await host.scheduler.enqueueRun(runId);
  const failingStorage = new FailingRunLookupStorage(options.storage, runId);
  const summary = await drainCloudflareAlarm({
    agent: createWorkerCoordinator(failingStorage, options.env, {
      prefix: options.route.storePrefix,
      scenario: "durable-background",
    }),
    prefix: options.route.storePrefix,
    storage: failingStorage,
  });
  return scenarioResult(
    "resume-retry",
    summary.events,
    [
      "scenario:resume-retry",
      summary.failedRuns.length > 0 ? "resume:retry-scheduled" : "resume:ok",
    ],
    undefined,
    options.request.stress.summaryEvents
  );
}

export async function runCancelStaleChildScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const agent = createWorkerCoordinator(options.storage, options.env, {
    prefix: options.route.storePrefix,
    scenario: "durable-background",
  });
  const events = await drainAgentRun(
    await agent.session(options.route.sessionKey).send(inputText(options))
  );
  const runId = (
    await listScheduledCloudflareRuns(options.storage, {
      prefix: options.route.storePrefix,
    })
  )[0];
  if (runId) {
    const host = createCloudflareDurableObjectHost({
      prefix: options.route.storePrefix,
      storage: options.storage,
    });
    const run = await host.store.runs.get(runId);
    if (run) {
      await host.store.runs.update({ ...run, status: "cancelled" });
    }
    await agent.resume(runId);
  }
  return scenarioResult(
    "cancel-stale-child",
    events,
    ["scenario:cancel-stale-child", "cancel:stale-child"],
    undefined,
    options.request.stress.summaryEvents
  );
}

function inputText(options: RunStressScenarioOptions): string {
  return typeof options.request.input === "string"
    ? options.request.input
    : "cancel stale child";
}
