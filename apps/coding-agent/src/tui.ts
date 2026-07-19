import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Container,
  Input,
  matchesKey,
  ProcessTerminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import { type AgentOptions, createAgent } from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import type { ToolSet } from "ai";
import { createCodingLanguageModel } from "./model";
import { resolveCodingAgentThreadConfig } from "./thread-config";
import { resolveStartTuiTools } from "./tools";
import { createTuiRunner, formatTuiHeader } from "./tui-runner";

export interface StartTuiOptions {
  /**
   * Optional tool set passed straight to the `Agent`. When omitted, the TUI
   * enables OpenSearch-backed web_search and web_fetch tools when
   * TINYFISH_API_KEY is configured; otherwise the web tools are omitted and a
   * warning is logged (availability mode "optional").
   */
  readonly tools?: ToolSet;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const threadConfig = resolveCodingAgentThreadConfig();
  const agentOptions: AgentOptions = {
    host: createFileHost({ directory: threadConfig.directory }),
    instructions:
      "Answer in 2 short sentences and 280 characters or fewer unless the user explicitly asks for detail. Avoid headings.",
    model: createCodingLanguageModel(),
    autoCompaction: threadConfig.autoCompaction,
    tools: resolveStartTuiTools(options.tools),
  };
  const agent = await createAgent(agentOptions);
  const thread = agent.thread(threadConfig.key);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const chat = new Container();
  const input = new Input();

  tui.addChild(
    new Text(
      formatTuiHeader({
        autoCompaction: threadConfig.autoCompaction,
        threadKey: threadConfig.key,
      }),
      1,
      0
    )
  );
  tui.addChild(chat);
  tui.addChild(input);
  tui.setFocus(input);

  let finish: () => void;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });

  const addLine = (text: string): void => {
    chat.addChild(new Text(text, 1, 0));
    tui.requestRender();
  };

  const runner = createTuiRunner({
    addLine,
    requestRender: () => tui.requestRender(),
    thread,
  });

  input.onSubmit = (text) => {
    input.setValue("");
    runner.submit(text);
  };

  const removeInputListener = tui.addInputListener((data) => {
    // Avoid input.onEscape because pi-tui maps both Escape and Ctrl-C to it.
    if (matchesKey(data, "escape")) {
      thread.interrupt();
      return { consume: true };
    }

    if (!matchesKey(data, "ctrl+c")) {
      return;
    }

    removeInputListener();
    thread.dispose();
    runner.clearActiveRun();
    tui.stop();
    finish();
    return { consume: true };
  });

  tui.start();
  tui.requestRender();

  await done;
}

function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

if (isMainModule(import.meta.url)) {
  await startTui();
}
