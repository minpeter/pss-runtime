import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = await Agent.create({
  instructions: "Keep every answer under 3 lines.",
  model: createCodingAgentModel(),
  tools,
});
const run = await agent.send("Find information about minpeter.");
for await (const event of run.stream()) {
  console.dir(event, { depth: null });
}
