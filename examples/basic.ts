import { Agent } from "../src/runtime/agent";

const agent = new Agent();
const session = agent.createSession();

session.subscribe((event) => {
  console.log(event);
});

await session.submit({
  type: "user-text",
  text: "Say hello in one short sentence.",
});
