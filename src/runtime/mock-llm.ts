export type LlmOutputPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string };

export type LlmOutput = LlmOutputPart[];
export type LlmContext = { signal: AbortSignal };
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
      return [{ type: "text", text: "DONE" }];
    }

    if (roll < 0.65) {
      return [{ type: "tool-call", toolName: "continue" }];
    }

    return [
      { type: "text", text: "I should keep going." },
      { type: "tool-call", toolName: "continue" },
    ];
  };
}

export const mockLlm = createMockLlm();
