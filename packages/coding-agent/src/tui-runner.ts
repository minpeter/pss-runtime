import type {
  AgentEvent,
  AgentRun,
  SessionHandle,
  UserInput,
  UserMessage,
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
  readonly session: Pick<SessionHandle, "send">;
}

export interface TuiRunner {
  readonly activeRun: AgentRun | undefined;
  consumeRun(run: AgentRun): Promise<void>;
  clearActiveRun(run?: AgentRun): void;
  submit(text: string): void;
}

const dimText = "\x1b[2m";
const resetText = "\x1b[0m";

export const formatUserTextContent = (text: UserTextContent): string =>
  typeof text === "string" ? text : text.join("\n");

export const formatEvent = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "user-text":
      return `\x1b[36myou\x1b[0m: ${safeText(formatUserTextContent(event.text))}`;
    case "user-message":
      return `\x1b[36myou\x1b[0m: ${safeText(formatUserMessageContent(event))}`;
    case "runtime-input":
      return `${dimText}runtime: ${safeText(formatRuntimeInput(event.input))}${resetText}`;
    case "assistant-text":
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
  session,
}: TuiRunnerOptions): TuiRunner {
  let activeRun: AgentRun | undefined;

  const clearActiveRun = (run?: AgentRun): void => {
    if (run === undefined || activeRun === run) {
      activeRun = undefined;
    }
  };

  const consumeRun = async (run: AgentRun): Promise<void> => {
    activeRun = run;

    try {
      for await (const event of run.stream()) {
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
      run.input.add(trimmed).catch((error: unknown) => {
        addLine(`\x1b[31merror\x1b[0m: ${safeText(errorMessage(error))}`);
      });
      return;
    }

    session
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
  if (isUserText(input)) {
    return formatUserTextContent(input.text);
  }

  if (isUserMessage(input)) {
    return formatUserMessageContent(input);
  }

  return safeInlineText(String(input));
}

function formatUserMessageContent(message: UserMessage): string {
  return message.content.map(formatUserMessagePart).join("\n");
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

function isUserMessage(input: unknown): input is UserMessage {
  return (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "user-message" &&
    "content" in input &&
    Array.isArray(input.content)
  );
}

function isUserText(
  input: unknown
): input is { text: UserTextContent; type: "user-text" } {
  return (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "user-text" &&
    "text" in input &&
    (typeof input.text === "string" || Array.isArray(input.text))
  );
}
