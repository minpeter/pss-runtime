import { Agent } from "../src";

const agent = new Agent();

agent.subscribe((event) => {
  console.log(event);
});

await agent.run();
