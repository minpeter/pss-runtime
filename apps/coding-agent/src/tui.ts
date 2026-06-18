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
import { Agent, type AgentOptions } from "@minpeter/pss-runtime";
import { FileSessionStore } from "@minpeter/pss-runtime/session-store/file";
import type { ToolSet } from "ai";
import { createCodingLanguageModel } from "./model";
import { resolveCodingAgentSessionConfig } from "./session-config";
import { createTuiRunner } from "./tui-runner";
import { safeInlineText } from "./tui-tool-printer";

export interface StartTuiOptions {
  /**
   * Optional tool set passed straight to the `Agent`. The `pss` TUI ships no
   * built-in tools; pass your own (for example `@minpeter/pss-web-tools`) when
   * you want the model to call them.
   */
  readonly tools?: ToolSet;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const sessionConfig = resolveCodingAgentSessionConfig();
  const agentOptions: AgentOptions = {
    host: {
      kind: "session",
      sessionStore: new FileSessionStore(sessionConfig.directory),
    },
    instructions:
      "Answer in 2 short sentences and 280 characters or fewer unless the user explicitly asks for detail. Avoid headings.",
    model: createCodingLanguageModel(),
    tools: options.tools,
  };
  const agent = new Agent(agentOptions);
  const session = agent.session(sessionConfig.key);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const chat = new Container();
  const input = new Input();

  tui.addChild(
    new Text(
      `\x1b[1mpss-next\x1b[0m \x1b[2m(session ${safeInlineText(sessionConfig.key)} · Esc to interrupt · Ctrl-C to quit)\x1b[0m`,
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
    session,
  });

  input.onSubmit = (text) => {
    input.setValue("");
    runner.submit(text);
  };

  const removeInputListener = tui.addInputListener((data) => {
    // Avoid input.onEscape because pi-tui maps both Escape and Ctrl-C to it.
    if (matchesKey(data, "escape")) {
      session.interrupt();
      return { consume: true };
    }

    if (!matchesKey(data, "ctrl+c")) {
      return;
    }

    removeInputListener();
    session.dispose();
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
