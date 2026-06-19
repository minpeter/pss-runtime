import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { drain } from "./drain";
import { thread } from "./setup";

output.write(
  ["local file agent CLI", "exit: /quit", "message:", ""].join("\n")
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

    await drain(await thread.send(text));
    output.write("\n");
  }
} finally {
  rl.close();
}
