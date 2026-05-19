import { tools } from "@pss-next/coding-agent";
import { Agent } from "@pss-next/runtime";

const agent = new Agent({
  instructions: "Keep every answer under 3 lines.",
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
