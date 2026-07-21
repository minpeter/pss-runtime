import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Container,
  Input,
  Markdown,
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
import {
  assistantText,
  dimText,
  markdownDefaultTextStyle,
  markdownTheme,
} from "./tui-theme";
import { safeText } from "./tui-tool-printer";
import { UPDATE_CHECK_CACHE_FILENAME } from "./update/check";
import { cliVersion } from "./update/cli-version";
import { emitUpdateNotice } from "./update/notifier";

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
  const startupNotices: string[] = [];
  const threadConfig = resolveCodingAgentThreadConfig();
  const agentOptions: AgentOptions = {
    host: createFileHost({ directory: threadConfig.directory }),
    instructions:
      "Answer in 2 short sentences and 280 characters or fewer unless the user explicitly asks for detail. Avoid headings.",
    model: createCodingLanguageModel(),
    autoCompaction: threadConfig.autoCompaction,
    tools: resolveStartTuiTools(options.tools, {
      onWebToolsDisabled: (message) => startupNotices.push(message),
    }),
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

  const addMarkdown = (text: string): void => {
    chat.addChild(new Text(assistantText("assistant:"), 1, 0));
    chat.addChild(
      new Markdown(
        safeText(text),
        1,
        0,
        markdownTheme,
        markdownDefaultTextStyle
      )
    );
    tui.requestRender();
  };

  const runner = createTuiRunner({
    addLine,
    addMarkdown,
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

  for (const notice of startupNotices) {
    addLine(dimText(notice));
  }
  const deferredRefreshes: (() => Promise<void>)[] = [];
  await emitUpdateNotice({
    write: (line) => addLine(dimText(line)),
    env: process.env,
    version: cliVersion,
    cachePath: join(homedir(), ".pss", UPDATE_CHECK_CACHE_FILENAME),
    schedule: (task) => deferredRefreshes.push(task),
  });

  tui.start();
  tui.requestRender();
  for (const refresh of deferredRefreshes) {
    refresh();
  }

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
