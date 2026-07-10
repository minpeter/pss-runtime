import { createAILogger } from "@ai-sdk-tool/middleware/evlog";
import type { LanguageModel } from "ai";
import type { RequestLogger } from "evlog";

/**
 * Wrap a LanguageModelV4 with evlog AI middleware so generateText tokens,
 * timing, and tool-call inputs land on the request wide event (`log.set({ ai })`).
 *
 * Create a fresh wrapper per turn so token counters do not accumulate across
 * long-lived Durable Object agent instances.
 */
export function wrapModelWithAiLogger(
  model: LanguageModel,
  log: RequestLogger,
  options?: {
    readonly toolInputs?: boolean | { readonly maxLength?: number };
  }
): LanguageModel {
  const ai = createAILogger(log, {
    toolInputs: options?.toolInputs ?? { maxLength: 800 },
  });
  return ai.wrap(model as Parameters<typeof ai.wrap>[0]) as LanguageModel;
}
