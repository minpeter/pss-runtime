import { Agent, type Llm } from "../src";

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

let llmCalls = 0;
const llm: Llm = async ({ signal }) => {
  llmCalls += 1;

  if (llmCalls === 1) {
    await sleep(1000, signal);
    return [{ type: "tool-call", toolName: "continue" }];
  }

  await sleep(300, signal);
  return [{ type: "text", text: "DONE" }];
};

const agent = new Agent({ llm });
const session = agent.createSession();

session.subscribe((event) => {
  console.log(event);
});

const first = session.submit({ type: "user-message", text: "long running input" });
const second = session.submit({
  type: "user-message",
  text: "queued input while first is running",
});

setTimeout(() => {
  console.log("interrupt active turn");
  session.interrupt();
}, 300);

await Promise.all([first, second]);
