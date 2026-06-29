import type { AgentTurn } from "@minpeter/pss-runtime";

export async function drain(run: AgentTurn) {
  for await (const event of run.events()) {
    switch (event.type) {
      case "assistant-output":
        process.stdout.write(`\n${event.text}\n`);
        break;
      case "tool-call":
        console.log(`\n[tool] ${event.toolName}`);
        break;
      case "tool-result":
        console.log(`[tool-result] ${event.toolName}`);
        break;
      default:
        console.log(`\n[${event.type}]`, event);
    }
  }
}
