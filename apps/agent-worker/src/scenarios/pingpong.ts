import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import {
  type CloudflareAlarmAgent,
  createCloudflareDurableObjectHost,
  drainCloudflareAlarm,
  listScheduledCloudflareRuns,
} from "@minpeter/pss-runtime/cloudflare";
import type { RunStressScenarioOptions } from ".";
import { type StressScenarioResult, scenarioResult } from "./result";

const fiveMinutesMs = 5 * 60 * 1000;

export async function runLongRunningPingPongScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const { pingPongDelayMs, pingPongHops, summaryEvents } =
    options.request.stress;
  const prefix = options.route.storePrefix;
  const host = createCloudflareDurableObjectHost({
    prefix,
    storage: options.storage,
  });
  const agent = createPingPongAgent();
  const events: AgentEvent[] = [];
  const markers = [
    "scenario:long-running-pingpong",
    `pingpong:hops:${pingPongHops}`,
    `pingpong:delay-ms:${pingPongDelayMs}`,
  ];

  for (let hop = 1; hop <= pingPongHops; hop += 1) {
    const runId = pingPongRunId(hop);
    await host.scheduler.enqueueRun(runId, {
      runAfterMs: pingPongDelayMs,
    });
    markers.push(`pingpong:scheduled:${hop}`);
    markers.push(
      `pingpong:queued:${(await listScheduledCloudflareRuns(options.storage, { prefix })).length}`
    );

    const alarm = await drainCloudflareAlarm({
      agent,
      prefix,
      storage: options.storage,
    });
    events.push(...alarm.events);
    markers.push(...alarm.resumedRuns.map((id) => `pingpong:resumed:${id}`));
  }

  const elapsedMs = pingPongHops * pingPongDelayMs;
  markers.push(
    `pingpong:remaining:${(await listScheduledCloudflareRuns(options.storage, { prefix })).length}`
  );
  markers.push(`pingpong:elapsed-ms:${elapsedMs}`);
  markers.push(
    elapsedMs > fiveMinutesMs ? "long-running:over-5m" : "long-running:under-5m"
  );

  return scenarioResult(
    "long-running-pingpong",
    events,
    markers,
    undefined,
    summaryEvents
  );
}

function createPingPongAgent(): CloudflareAlarmAgent {
  return {
    resume: (runId) => Promise.resolve(runFromEvents(eventsForRun(runId))),
  };
}

function eventsForRun(runId: string): readonly AgentEvent[] {
  return [
    {
      text: `resumed ${runId}`,
      type: "assistant-text",
    },
  ];
}

function runFromEvents(events: readonly AgentEvent[]): AgentRun {
  return {
    events: () => iterateEvents(events),
  };
}

function iterateEvents(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: () => {
          const event = events[index];
          if (!event) {
            return Promise.resolve({ done: true, value: undefined });
          }
          index += 1;
          return Promise.resolve({ done: false, value: event });
        },
      };
    },
  };
}

function pingPongRunId(hop: number): string {
  return `background:pingpong:${hop}`;
}
