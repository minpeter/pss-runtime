import type { AssistantText, ModelHistoryItem, ToolCall } from "./session";

export type LlmOutputPart = AssistantText | ToolCall;

export type LlmOutput = LlmOutputPart[];
export type LlmContext = {
  history: readonly ModelHistoryItem[];
  signal: AbortSignal;
};
export type Llm = (context: LlmContext) => Promise<LlmOutput>;

const mockLlmDelayMs = 300;

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

export function createMockLlm(): Llm {
  return async ({ signal }) => {
    await delay(mockLlmDelayMs, signal);

    const roll = Math.random();

    if (roll < 0.3) {
      return [{ type: "assistant-text", text: "DONE" }];
    }

    if (roll < 0.65) {
      return [{ type: "tool-call", toolName: "continue" }];
    }

    return [
      { type: "assistant-text", text: "I should keep going." },
      { type: "tool-call", toolName: "continue" },
    ];
  };
}

export const mockLlm = createMockLlm();
