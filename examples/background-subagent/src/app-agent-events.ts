import type { AgentTurn } from "@minpeter/pss-runtime";

type RunEvents =
  Awaited<ReturnType<AgentTurn["events"]>> extends AsyncIterable<infer Event>
    ? Event[]
    : never[];

export async function collectRunEvents(run: AgentTurn): Promise<RunEvents> {
  const events: RunEvents = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

export function collectAssistantOutput(events: RunEvents): string {
  return events
    .filter((event) => event.type === "assistant-output")
    .map((event) => event.text)
    .join("\n");
}

export function replayRun(events: RunEvents): AgentTurn {
  return {
    events: () => eventStream(events),
  };
}

async function* eventStream(events: RunEvents) {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
