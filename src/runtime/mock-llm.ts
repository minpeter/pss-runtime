export type LlmOutput =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string };

export function createMockLlm(random?: () => number) {
  return async (): Promise<LlmOutput> =>
    (random ?? Math.random)() < 0.3
      ? { type: "text", text: "DONE" }
      : { type: "tool-call", toolName: "continue" };
}

export const mockLlm = createMockLlm();
