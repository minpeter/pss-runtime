import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { drain } from "./drain";
import { session } from "./setup";

output.write(
  ["basic CLI", "종료: /quit", "메시지를 입력하세요.", ""].join("\n")
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

    await drain(await session.send(text));
    output.write("\n");
  }
} finally {
  rl.close();
}
