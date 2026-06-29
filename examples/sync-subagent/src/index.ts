import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { drainRunForCli } from "./print-run";
import { createExampleRuntime } from "./setup";

const runtime = createExampleRuntime();

output.write(
  [
    "sync-subagent CLI",
    "종료: /quit",
    "kb/ 지식베이스 질문을 입력하세요. reader가 관련 문서를 읽고 답합니다.",
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
