import type { ModelMessage } from "ai";
import { expect, vi } from "vitest";
import { Agent } from "../../agent/core/agent";

export interface AutoCompactionConfig {
  readonly minMessages: number;
  readonly retainMessages: number;
}

export type AutoCompactionAgentOptions = ConstructorParameters<
  typeof Agent
>[0] & {
  readonly autoCompaction?: AutoCompactionConfig;
};

export const agentWithAutoCompaction = (
  options: AutoCompactionAgentOptions
): Agent => new Agent(options);

export const storedAssistantText = (text: string): ModelMessage => ({
  content: [{ providerOptions: undefined, text, type: "text" }],
  role: "assistant",
});

export const waitForModelCalls = async (
  calls: () => number,
  expected: number
): Promise<void> => {
  await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(expected), {
    interval: 5,
    timeout: 200,
  });
};

export const nextMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
