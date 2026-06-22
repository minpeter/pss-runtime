import type {
  AgentEvent,
  AgentTurn,
  ThreadHandle,
  UserInput,
  UserMessageContentPart,
  UserTextContent,
} from "@minpeter/pss-runtime";
import {
  formatToolCallForTui,
  formatToolResultForTui,
  safeInlineText,
  safeText,
  truncateDetail,
} from "./tui-tool-printer";

export interface TuiRunnerOptions {
  readonly addLine: (text: string) => void;
  readonly requestRender: () => void;
  readonly thread: Pick<ThreadHandle, "send" | "steer">;
}

export interface TuiRunner {
  readonly activeRun: AgentTurn | undefined;
  clearActiveRun(run?: AgentTurn): void;
  consumeRun(run: AgentTurn): Promise<void>;
  submit(text: string): void;
}

const dimText = "\x1b[2m";
const resetText = "\x1b[0m";

export const formatUserTextContent = (text: UserTextContent): string =>
  typeof text === "string" ? text : text.join("\n");

export const formatEvent = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "user-input":
      return `\x1b[36myou\x1b[0m: ${safeText(formatUserInput(event))}`;
    case "runtime-input":
      return `${dimText}runtime: ${safeText(formatRuntimeInput(event.input))}${resetText}`;
    case "assistant-output":
      return `\x1b[32massistant\x1b[0m: ${safeText(event.text)}`;
    case "assistant-reasoning":
      return `\x1b[35mreasoning\x1b[0m: ${truncateDetail(safeInlineText(event.text), 240)}`;
    case "tool-call":
      return `\x1b[33mtool\x1b[0m ${formatToolCallForTui(event)}`;
    case "tool-result":
      return `\x1b[33mtool result\x1b[0m ${formatToolResultForTui(event)}`;
    case "turn-start":
      return `${dimText}running...${resetText}`;
    case "turn-abort":
      return `${dimText}interrupted${resetText}`;
    case "turn-error":
      return `\x1b[31merror\x1b[0m: ${safeText(event.message)}`;
    case "turn-end":
      return `${dimText}done${resetText}`;
    case "step-start":
    case "step-end":
      return;
    default:
      return;
  }
};

export function createTuiRunner({
  addLine,
  requestRender,
  thread,
}: TuiRunnerOptions): TuiRunner {
  let activeRun: AgentTurn | undefined;

  const clearActiveRun = (run?: AgentTurn): void => {
    if (run === undefined || activeRun === run) {
      activeRun = undefined;
    }
  };

  const consumeRun = async (run: AgentTurn): Promise<void> => {
    activeRun = run;

    try {
      for await (const event of run.events()) {
        const line = formatEvent(event);
        if (line) {
          addLine(line);
        }

        if (isTerminalTurnEvent(event)) {
          clearActiveRun(run);
        }
      }
    } finally {
      clearActiveRun(run);
    }
  };

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      requestRender();
      return;
    }

    const run = activeRun;
    if (run) {
      thread
        .steer(trimmed)
        .then((nextRun) => {
          if (nextRun !== run) {
            return consumeRun(nextRun);
          }
        })
        .catch((error: unknown) => {
          addLine(`\x1b[31merror\x1b[0m: ${safeText(errorMessage(error))}`);
        });
      return;
    }

    thread
      .send(trimmed)
      .then((nextRun) => consumeRun(nextRun))
      .catch((error: unknown) => {
        addLine(`\x1b[31merror\x1b[0m: ${safeText(errorMessage(error))}`);
      });
  };

  return {
    get activeRun() {
      return activeRun;
    },
    clearActiveRun,
    consumeRun,
    submit,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRuntimeInput(input: UserInput): string {
  if ("text" in input) {
    return formatUserTextContent(input.text);
  }

  if ("content" in input) {
    return formatUserMessageContent(input.content);
  }

  return safeInlineText(String(input));
}

function formatUserInput(input: UserInput): string {
  if ("text" in input) {
    return formatUserTextContent(input.text);
  }

  return formatUserMessageContent(input.content);
}

function formatUserMessageContent(
  content: readonly UserMessageContentPart[]
): string {
  return content.map(formatUserMessagePart).join("\n");
}

function formatUserMessagePart(part: UserMessageContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return `[image ${part.mediaType ?? "unknown"}]`;
    case "file":
      return `[file ${part.filename ?? part.mediaType}]`;
    default:
      return "[input]";
  }
}

function isTerminalTurnEvent(event: AgentEvent): boolean {
  return (
    event.type === "turn-end" ||
    event.type === "turn-error" ||
    event.type === "turn-abort"
  );
}
