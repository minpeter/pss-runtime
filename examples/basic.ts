import { Agent } from "../src";

const agent = new Agent();
const session = agent.createSession();

session.subscribe((event) => {
  console.log(event);
});

await session.submit({
  role: "user",
  content: "Say hello in one short sentence.",
});
