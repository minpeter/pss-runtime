import {
  Container,
  Input,
  matchesKey,
  ProcessTerminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import { Agent } from "../src/runtime/agent";
import type { AgentEvent } from "../src/runtime/session/events";

const agent = new Agent();
const session = agent.createSession();

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const chat = new Container();
const input = new Input();

tui.addChild(
  new Text(
    "\x1b[1mpss-next\x1b[0m \x1b[2m(Esc to interrupt · Ctrl-C to quit)\x1b[0m",
    1,
    0
  )
);
tui.addChild(chat);
tui.addChild(input);
tui.setFocus(input);

let finish: () => void;
const done = new Promise<void>((resolve) => {
  finish = resolve;
});

const addLine = (text: string): void => {
  chat.addChild(new Text(text, 1, 0));
  tui.requestRender();
};

const isTerminalControlCharacter = (value: string): boolean => {
  const code = value.codePointAt(0);

  return (
    code !== undefined &&
    (code <= 0x08 ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f))
  );
};

const safeText = (text: string): string =>
  Array.from(text)
    .filter((value) => !isTerminalControlCharacter(value))
    .join("");

const formatEvent = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "user-text":
      return `\x1b[36myou\x1b[0m: ${safeText(event.text)}`;
    case "assistant-text":
      return `\x1b[32massistant\x1b[0m: ${safeText(event.text)}`;
    case "tool-call":
      return `\x1b[33mtool\x1b[0m: ${safeText(event.toolName)}`;
    case "turn-start":
      return "\x1b[2mrunning...\x1b[0m";
    case "turn-abort":
      return "\x1b[2minterrupted\x1b[0m";
    case "turn-error":
      return `\x1b[31merror\x1b[0m: ${safeText(event.message)}`;
    case "turn-end":
      return "\x1b[2mdone\x1b[0m";
    case "step-start":
    case "step-end":
      return;
    default:
      return;
  }
};

session.subscribe((event) => {
  const line = formatEvent(event);
  if (line) {
    addLine(line);
  }
});

input.onSubmit = (text) => {
  input.setValue("");

  const trimmed = text.trim();
  if (!trimmed) {
    tui.requestRender();
    return;
  }

  session
    .submit({ type: "user-text", text: trimmed })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      addLine(`\x1b[31merror\x1b[0m: ${safeText(message)}`);
    });
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
  session.kill();
  tui.stop();
  finish();
  return { consume: true };
});

tui.start();
tui.requestRender();

await done;
