import type {
  AgentEvent,
  AgentOptions,
  AgentTurn,
  ThreadHandle,
  UserInput,
  UserMessageContentPart,
  UserTextContent,
} from "@minpeter/pss-runtime";
import {
  assistantText,
  boldText,
  dimText,
  errorText,
  reasoningText,
  toolText,
  userText,
} from "./tui-theme";
import {
  formatToolCallForTui,
  formatToolResultForTui,
  safeInlineText,
  safeText,
  truncateDetail,
} from "./tui-tool-printer";

interface TuiRunnerOptions {
  readonly addLine: (text: string) => void;
  /**
   * Render assistant output as rich markdown instead of a plain formatted
   * line. When provided, `assistant-output` events are routed here and skip
   * `formatEvent`/`addLine`.
   */
  readonly addMarkdown?: (text: string) => void;
  readonly requestRender: () => void;
  readonly thread: Pick<ThreadHandle, "send" | "steer">;
}

export interface TuiRunner {
  readonly activeRun: AgentTurn | undefined;
  clearActiveRun(run?: AgentTurn): void;
  consumeRun(run: AgentTurn): Promise<void>;
  submit(text: string): void;
}

interface TuiHeaderOptions {
  readonly autoCompaction: AgentOptions["autoCompaction"];
  readonly threadKey: string;
}

export function formatTuiHeader({
  autoCompaction,
  threadKey,
}: TuiHeaderOptions): string {
  const compactionText = autoCompaction
    ? `compaction min=${autoCompaction.minMessages} retain=${autoCompaction.retainMessages}`
    : "compaction off";
  return `${boldText("pss-next")} ${dimText(`(thread ${safeInlineText(threadKey)} \u00b7 ${compactionText} \u00b7 Esc to interrupt \u00b7 Ctrl-C to quit)`)}`;
}

export const formatUserTextContent = (text: UserTextContent): string =>
  typeof text === "string" ? text : text.join("\n");

export const formatEvent = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "user-input":
      return `${userText("you")}: ${safeText(formatUserInput(event))}`;
    case "runtime-input":
      return dimText(`runtime: ${safeText(formatRuntimeInput(event.input))}`);
    case "assistant-output":
      return `${assistantText("assistant")}: ${safeText(event.text)}`;
    case "assistant-reasoning":
      return `${reasoningText("reasoning")}: ${truncateDetail(safeInlineText(event.text), 240)}`;
    case "tool-call":
      return `${toolText("tool")} ${formatToolCallForTui(event)}`;
    case "tool-result":
      return `${toolText("tool result")} ${formatToolResultForTui(event)}`;
    case "turn-start":
      return dimText("running...");
    case "turn-abort":
      return dimText("interrupted");
    case "turn-error":
      return `${errorText("error")}: ${safeText(event.message)}`;
    case "turn-end":
      return dimText("done");
    case "step-start":
    case "step-end":
      return;
    default:
      return;
  }
};

export function createTuiRunner({
  addLine,
  addMarkdown,
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
        if (event.type === "assistant-output" && addMarkdown !== undefined) {
          addMarkdown(event.text);
        } else {
          const line = formatEvent(event);
          if (line) {
            addLine(line);
          }
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
