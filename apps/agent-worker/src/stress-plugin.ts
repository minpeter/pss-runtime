import type { AgentPlugin } from "@minpeter/pss-runtime";

export interface StressPluginCounter {
  readonly counts: Readonly<Record<string, number>>;
  readonly plugin: AgentPlugin;
}

export function createStressPluginCounter(): StressPluginCounter {
  const counts: Record<string, number> = {};
  return {
    counts,
    plugin: {
      events: {
        on: ({ event }) => {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
        },
      },
      name: "agent-worker-stress-counter",
    },
  };
}
