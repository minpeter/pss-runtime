import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { drainRunForCli } from "./print-run";
import { createExampleRuntime } from "./setup";

const runtime = await createExampleRuntime();

output.write(
  [
    "sync-subagent CLI",
    "Shutdown: /quit",
    "kb/ Please enter a knowledgebase question. readerReads and answers relevant documents.",
    "",
  ].join("\n")
);

const rl = createInterface({ input, output });

try {
  while (true) {
    const line = await rl.question("> ");
    const text = line.trim();
    if (!text) {
      continue;
    }
    if (text === "/quit") {
      break;
    }

    await drainRunForCli(await runtime.thread.send(text));
    output.write("\n");
  }
} finally {
  rl.close();
}
