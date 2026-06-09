import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import type { LocalHost } from "./local-host";
import { drainRunForCli } from "./print-run";
import { createExampleRuntime } from "./setup";

const notificationPollMs = 300;
const notificationTimeoutMs = 1000;

const runtime = createExampleRuntime();
let active = true;

output.write(
  [
    "background-subagent CLI",
    "종료: /quit",
    "kb/ 지식베이스 질문 가능. 백그라운드 작업 중에도 계속 입력할 수 있어요.",
    "",
  ].join("\n")
);

startBackgroundWatcher(runtime.host);

const rl = readline.createInterface({ input, output });

try {
  while (active) {
    const line = await rl.question("> ");
    const text = line.trim();
    if (!text) {
      continue;
    }
    if (text === "/quit") {
      break;
    }

    await drainRunForCli(await runtime.session.send(text));
    output.write("\n");
  }
} finally {
  active = false;
  rl.close();
}

function startBackgroundWatcher(host: LocalHost) {
  void (async () => {
    while (active) {
      try {
        const run = await host.resumeSession({
          timeoutMs: notificationTimeoutMs,
        });
        output.write("\n--- [system] 백그라운드 작업 완료 ---\n");
        await drainRunForCli(run);
        output.write("\n");
      } catch {
        await sleep(notificationPollMs);
      }
    }
  })();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
