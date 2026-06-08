import type { AgentEvent } from "@minpeter/pss-runtime";
import {
  type CloudflareDurableObjectStorage,
  drainCloudflareAlarm,
  listScheduledCloudflareRuns,
} from "@minpeter/pss-runtime/cloudflare";
import { createWorkerCoordinator } from "../agent/factory";
import type { WorkerRoute } from "../request/route";
import {
  appBudgets,
  type ScenarioId,
  scenarioIds,
  type TurnRequest,
} from "../request/schema";
import {
  runCancelStaleChildScenario,
  runDuplicateAlarmScenario,
  runResumeRetryScenario,
} from "./edge";
import { guardScenario } from "./guards";
import { createStressPluginCounter } from "./plugin";
import { type StressScenarioResult, scenarioResult } from "./result";

export interface HealthPayload {
  readonly app: "pss-agent-worker";
  readonly bindingPresent: boolean;
  readonly budgets: typeof appBudgets;
  readonly features: readonly string[];
  readonly scenarioIds: readonly ScenarioId[];
}

export interface RunStressScenarioOptions {
  readonly env: unknown;
  readonly request: TurnRequest;
  readonly route: WorkerRoute;
  readonly storage: CloudflareDurableObjectStorage;
}

export function createHealthPayload(options: {
  readonly bindingPresent: boolean;
}): HealthPayload {
  return {
    app: "pss-agent-worker",
    bindingPresent: options.bindingPresent,
    budgets: appBudgets,
    features: [
      "run.events",
      "multipart-input",
      "plugins",
      "tools",
      "toolChoice",
      "blocking-subagent",
      "durable-background-subagent",
      "background_output",
      "background_cancel",
      "session.steer",
      "Agent.resume",
      "bounded-guards",
    ],
    scenarioIds,
  };
}

export async function runStressScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  switch (options.request.scenario) {
    case "foreground-basic":
    case "multipart-input":
    case "tool-choice":
    case "blocking-subagent":
    case "durable-background":
    case "background-cancel":
      return await runAgentScenario(options);
    case "plugin-events":
      return await runPluginScenario(options);
    case "background-output":
      return await runBackgroundOutputScenario(options);
    case "steer-step-end":
      return await runSteerScenario(options);
    case "duplicate-alarm":
      return await runDuplicateAlarmScenario(options);
    case "resume-retry":
      return await runResumeRetryScenario(options);
    case "cancel-stale-child":
      return await runCancelStaleChildScenario(options);
    case "request-rejection":
    case "fanout-guard":
    case "large-history-guard":
    case "checkpoint-size-guard":
    case "budget-guard":
      return guardScenario(options);
    default:
      return assertNever(options.request.scenario);
  }
}

async function runAgentScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const input =
    options.request.scenario === "multipart-input"
      ? options.request.input
      : inputText(options.request);
  const agent = createWorkerCoordinator(options.storage, options.env, {
    prefix: options.route.storePrefix,
    scenario: options.request.scenario,
  });
  const events = await collectEvents(
    await agent.session(options.route.sessionKey).send(input)
  );
  const markers = [`scenario:${options.request.scenario}`];
  if (options.request.scenario === "durable-background") {
    markers.push("request-boundary:launch");
    markers.push(
      (
        await listScheduledCloudflareRuns(options.storage, {
          prefix: options.route.storePrefix,
        })
      ).length > 0
        ? "alarm:scheduled"
        : "alarm:not-scheduled"
    );
  }
  return scenarioResult(
    options.request.scenario,
    events,
    markers,
    undefined,
    options.request.stress.summaryEvents
  );
}

async function runPluginScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const counter = createStressPluginCounter();
  const agent = createWorkerCoordinator(options.storage, options.env, {
    pluginCounter: counter,
    prefix: options.route.storePrefix,
    scenario: options.request.scenario,
  });
  const events = await collectEvents(
    await agent
      .session(options.route.sessionKey)
      .send(inputText(options.request))
  );
  return scenarioResult(
    options.request.scenario,
    events,
    [`scenario:${options.request.scenario}`, "plugin:events"],
    counter.counts,
    options.request.stress.summaryEvents
  );
}

async function runBackgroundOutputScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const agent = createWorkerCoordinator(options.storage, options.env, {
    prefix: options.route.storePrefix,
    scenario: "background-output",
  });
  const launchEvents = await collectEvents(
    await agent
      .session(options.route.sessionKey)
      .send(inputText(options.request))
  );
  const alarm = await drainCloudflareAlarm({
    agent,
    prefix: options.route.storePrefix,
    storage: options.storage,
  });
  return scenarioResult(
    "background-output",
    [...launchEvents, ...alarm.events],
    ["scenario:background-output", "request-boundary:launch", "alarm:resume"],
    undefined,
    options.request.stress.summaryEvents
  );
}

async function runSteerScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const agent = createWorkerCoordinator(options.storage, options.env, {
    prefix: options.route.storePrefix,
    scenario: "steer-step-end",
  });
  const session = agent.session(options.route.sessionKey);
  const run = await session.send(inputText(options.request));
  const events: AgentEvent[] = [];
  let steered = false;
  for await (const event of run.events()) {
    events.push(event);
    if (event.type === "step-end" && !steered) {
      steered = true;
      await session.steer("step-end steer input");
    }
  }
  return scenarioResult(
    "steer-step-end",
    events,
    ["scenario:steer-step-end", "session.steer:step-end"],
    undefined,
    options.request.stress.summaryEvents
  );
}

async function collectEvents(run: {
  events(): AsyncIterable<AgentEvent>;
}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

function inputText(request: TurnRequest): string {
  return typeof request.input === "string"
    ? request.input
    : `multipart:${request.scenario}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled scenario: ${value}`);
}
