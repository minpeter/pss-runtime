import { Agent, type AgentEvent, type AgentRun } from "@minpeter/pss-runtime";
import {
  createLocalCoordinatorModel,
  localResearcherModel,
} from "./local-background-model";
import { localHost } from "./local-host";

const sessionKey = "local:background:wait";
const host = localHost({ agent: createCoordinator });

const researcher = new Agent({
  name: "researcher",
  description: "Runs longer research tasks for the coordinator.",
  host,
  model: localResearcherModel,
  namespace: "local-wait-researcher",
});

const launchCoordinator = createCoordinator();
const session = launchCoordinator.session(sessionKey);
await drainRun(
  await session.send(
    "Start the one-sentence background researcher task and return after the launch is recorded."
  )
);

console.log("\n=== waiting for background completion ===");
await drainRun(await host.resumeSession());

function createCoordinator(): Agent {
  return new Agent({
    host,
    model: createLocalCoordinatorModel(),
    namespace: "local-wait-coordinator",
    instructions:
      "Coordinate the task. Start researcher work with delegate_to_researcher({ prompt: 'Give one sentence on why task IDs matter for background subagents.', run_in_background: true }) and save the returned task_id. Do not call background_output until a <system-reminder> says the task completed. After the reminder, call background_output({ task_id, block: true }) and summarize the result.",
    subagents: [researcher],
  });
}

async function drainRun(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
    console.log(event);
  }
  return events;
}
