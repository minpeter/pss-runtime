import type { AgentEvent, AgentTurn } from "@minpeter/pss-runtime";

export async function drainRunForCli(run: AgentTurn) {
  for await (const event of run.events()) {
    printCliEvent(event);
  }
}

function printCliEvent(event: AgentEvent) {
  switch (event.type) {
    case "assistant-text":
      process.stdout.write(event.text);
      return;
    case "tool-call":
      console.log(`\n[tool] ${event.toolName}`);
      return;
    case "tool-result":
      console.log(`[tool-result] ${event.toolName}`);
      return;
    case "turn-end":
      return;
    default:
      console.log(`\n[${event.type}]`, event);
  }
}
