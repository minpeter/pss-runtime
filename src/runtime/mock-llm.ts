export type LlmOutputPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string };

export type LlmOutput = LlmOutputPart[];
export type Llm = () => Promise<LlmOutput>;

export function createMockLlm(): Llm {
  return async () => {
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
