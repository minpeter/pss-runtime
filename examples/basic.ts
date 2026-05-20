import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = new Agent({
  instructions: "Keep every answer under 3 lines.",
  model: createCodingAgentModel(),
  tools,
});
const session = agent.createSession();

session.subscribe((event) => {
  console.dir(event, { depth: null });
});

await session.submit({
  type: "user-text",
  text: "Find information about minpeter.",
});
