import { Agent } from "@minpeter/pss-runtime";
import type { CloudflareDurableObjectStorage } from "./cloudflare-host";
import { createCloudflareDurableObjectHost } from "./cloudflare-host";
import type { ScenarioId } from "./request-schema";
import type { StressPluginCounter } from "./stress-plugin";
import { createStressPluginCounter } from "./stress-plugin";
import { createStressTools } from "./stress-tools";
import { workerStorePrefix } from "./worker-constants";
import { createStressModel, workerResearcherModel } from "./worker-model";

export interface WorkerCoordinatorOptions {
  readonly pluginCounter?: StressPluginCounter;
  readonly prefix?: string;
  readonly scenario?: ScenarioId;
}

export function createWorkerCoordinator(
  storage: CloudflareDurableObjectStorage,
  _env: unknown = {},
  options: WorkerCoordinatorOptions = {}
): Agent {
  const scenario = options.scenario ?? "durable-background";
  const host = createCloudflareDurableObjectHost({
    prefix: options.prefix ?? workerStorePrefix,
    storage,
  });
  const researcher = new Agent({
    description: "Produces compact research notes for the coordinator.",
    host,
    model: workerResearcherModel,
    name: "researcher",
    namespace: "cloudflare-worker-researcher",
  });
  const pluginCounter =
    options.pluginCounter ??
    (scenario === "plugin-events" ? createStressPluginCounter() : undefined);

  return new Agent({
    host,
    instructions: scenarioInstructions(scenario),
    model: createStressModel(scenario),
    namespace: "cloudflare-worker-coordinator",
    plugins: pluginCounter ? [pluginCounter.plugin] : [],
    subagents: [researcher],
    toolChoice:
      scenario === "tool-choice"
        ? { toolName: "worker_echo", type: "tool" }
        : undefined,
    tools: scenario === "tool-choice" ? createStressTools() : undefined,
  });
}

function scenarioInstructions(scenario: ScenarioId): string {
  return [
    "Coordinate a bounded Cloudflare Worker stress scenario.",
    `Scenario: ${scenario}.`,
    "Use deterministic tool calls only.",
    "For background work, wait for durable reminders before background_output.",
  ].join(" ");
}
