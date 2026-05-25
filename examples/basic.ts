import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = await Agent.create({
  instructions: "Keep every answer under 3 lines.",
  model: createCodingAgentModel(),
  tools,
});
const session = agent.session("default");
const run = await session.send("Find information about minpeter.");
let askedForSource = false;

for await (const event of run.stream()) {
  console.dir(event, { depth: null });

  if (event.type === "step-end" && !askedForSource) {
    askedForSource = true;
    await session.steer("Include the most relevant source you found.");
  }
}
