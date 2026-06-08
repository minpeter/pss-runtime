import {
  type CloudflareDurableObjectState,
  InMemoryCloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import { type ScenarioId, scenarioIds } from "../request/schema";
import type { StressScenarioResult } from "../scenarios/result";
import { AgentDurableObject } from "../worker";

const route = {
  conversationId: "edge-task-ids",
  tenantId: "demo",
  userId: "edge",
};
const simulationScenarios: readonly ScenarioId[] = [
  "foreground-basic",
  "multipart-input",
  "plugin-events",
  "tool-choice",
  "blocking-subagent",
  "durable-background",
  "background-output",
  "background-cancel",
  "duplicate-alarm",
  "resume-retry",
  "cancel-stale-child",
  "long-running-pingpong",
  "budget-guard",
];

console.log("health:scenarios", scenarioIds.length);
for (const scenario of simulationScenarios) {
  await runScenario(scenario);
}
await runRejectedRequest();

async function runScenario(scenario: ScenarioId): Promise<void> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const object = new AgentDurableObject(stateFor(storage), {});
  const response = await object.fetch(
    new Request("https://worker.example/turn", {
      body: JSON.stringify({
        conversationId: route.conversationId,
        input: inputForScenario(scenario),
        scenario,
        tenantId: route.tenantId,
        userId: route.userId,
      }),
      method: "POST",
    })
  );
  const result = await readScenarioResult(response);
  console.log(`${scenario}:markers`, result.markers.join(","));
  console.log(`${scenario}:events`, result.summary.eventTypes.join(","));

  if (scenario === "durable-background") {
    console.log("request-boundary:launch", result.markers.join(","));
    console.log("alarmScheduled", storage.alarmTime() !== undefined);
    const alarmSummary = await object.alarm();
    console.log("alarm:resume", alarmSummary.resumedRuns);
  }
}

async function runRejectedRequest(): Promise<void> {
  const storage = new InMemoryCloudflareDurableObjectStorage();
  const object = new AgentDurableObject(stateFor(storage), {});
  const response = await object.fetch(
    new Request("https://worker.example/turn", {
      body: JSON.stringify({}),
      method: "POST",
    })
  );
  console.log("request-rejection:status", response.status);
}

function stateFor(
  storage: InMemoryCloudflareDurableObjectStorage
): CloudflareDurableObjectState {
  return {
    storage,
    waitUntil: (promise) => {
      promise.catch((error: unknown) => {
        console.error(error);
      });
    },
  };
}

function inputForScenario(scenario: ScenarioId) {
  if (scenario === "multipart-input") {
    return [
      { text: "inspect", type: "text" },
      { image: "iVBORw0KGgo=", mediaType: "image/png", type: "image" },
      {
        data: { text: "inline document", type: "text" },
        filename: "note.txt",
        mediaType: "text/plain",
        type: "file",
      },
    ];
  }
  return `exercise ${scenario}`;
}

async function readScenarioResult(
  response: Response
): Promise<StressScenarioResult> {
  if (!response.ok) {
    throw new Error(`Worker simulation failed with ${response.status}.`);
  }
  const value = await response.json();
  if (isStressScenarioResult(value)) {
    return value;
  }
  throw new Error("Worker response did not include a scenario result.");
}

function isStressScenarioResult(value: unknown): value is StressScenarioResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "markers" in value &&
    "summary" in value
  );
}
