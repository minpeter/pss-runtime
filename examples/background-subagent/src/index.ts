import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { LocalHost } from "./local-host";
import { drainRunForCli } from "./print-run";
import { createExampleRuntime } from "./setup";

const notificationPollMs = 300;
const notificationTimeoutMs = 1000;

const runtime = await createExampleRuntime();
let active = true;
const backgroundWatchers = new Set<Promise<void>>();

output.write(
  [
    "background-subagent CLI",
    "Shutdown: /quit",
    "Ask questions about the kb/ knowledge base. You can keep entering messages while background tasks run.",
    "",
  ].join("\n")
);

startBackgroundWatcher(runtime.host);

const rl = createInterface({ input, output });

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

    await drainRunForCli(await runtime.thread.send(text));
    output.write("\n");
  }
} finally {
  active = false;
  rl.close();
}

function startBackgroundWatcher(host: LocalHost) {
  const watcher = watchBackgroundCompletions(host);
  backgroundWatchers.add(watcher);
  watcher.then(
    () => backgroundWatchers.delete(watcher),
    () => backgroundWatchers.delete(watcher)
  );
}

async function watchBackgroundCompletions(host: LocalHost) {
  while (active) {
    try {
      const run = await host.resumeThread({
        timeoutMs: notificationTimeoutMs,
      });
      output.write("\n--- [system] Background job completed ---\n");
      await drainRunForCli(run);
      output.write("\n");
    } catch {
      await sleep(notificationPollMs);
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
