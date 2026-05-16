import { Agent } from "../src";

const agent = new Agent();
const session = agent.createSession();

session.subscribe((event) => {
  console.log(event);
});

const first = session.submit({ type: "user-message", text: "first input" });
const second = session.submit({
  type: "user-message",
  text: "queued input",
});

setTimeout(() => {
  session.interrupt();
}, 100);

await Promise.all([first, second]);
