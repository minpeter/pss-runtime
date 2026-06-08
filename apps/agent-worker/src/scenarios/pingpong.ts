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
  const events: AgentEvent[] = [];
  const markers = [
    "scenario:long-running-pingpong",
    `pingpong:hops:${pingPongHops}`,
    `pingpong:delay-ms:${pingPongDelayMs}`,
  ];
  const agent = createPingPongAgent({
    markers,
    pingPongDelayMs,
    pingPongHops,
    scheduler: host.scheduler,
  });

  await host.scheduler.enqueueRun(pingPongRunId(1), {
    runAfterMs: pingPongDelayMs,
  });
  markers.push("pingpong:scheduled-initial:1");

  for (let boundary = 1; boundary <= pingPongHops; boundary += 1) {
    const scheduledRuns = await listScheduledCloudflareRuns(options.storage, {
      prefix,
    });
    if (scheduledRuns.length === 0) {
      markers.push(`pingpong:empty-boundary:${boundary}`);
      break;
    }

    markers.push(`pingpong:alarm-boundary:${boundary}`);
    markers.push(`pingpong:queued:${scheduledRuns.length}`);

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

interface PingPongScheduler {
  enqueueRun(
    runId: string,
    options?: { readonly runAfterMs?: number }
  ): Promise<void>;
}

function createPingPongAgent({
  markers,
  pingPongDelayMs,
  pingPongHops,
  scheduler,
}: {
  readonly markers: string[];
  readonly pingPongDelayMs: number;
  readonly pingPongHops: number;
  readonly scheduler: PingPongScheduler;
}): CloudflareAlarmAgent {
  return {
    resume: async (runId) => {
      const hop = readPingPongHop(runId);
      if (hop < pingPongHops) {
        const nextHop = hop + 1;
        await scheduler.enqueueRun(pingPongRunId(nextHop), {
          runAfterMs: pingPongDelayMs,
        });
        markers.push(`pingpong:scheduled-by-resume:${nextHop}`);
      }
      return runFromEvents(eventsForRun(runId));
    },
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

function readPingPongHop(runId: string): number {
  const lastSegment = runId.split(":").at(-1);
  const hop = lastSegment ? Number.parseInt(lastSegment, 10) : Number.NaN;
  if (!Number.isInteger(hop) || hop < 1) {
    throw new Error(`Invalid ping-pong run id: ${runId}`);
  }
  return hop;
}
