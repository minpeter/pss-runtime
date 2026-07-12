import { createAILogger } from "@ai-sdk-tool/middleware/evlog";
import type { LanguageModel } from "ai";
import type { RequestLogger } from "evlog";

/** Cap for tool-call input strings on the wide-event tree. */
export const AI_LOG_TEXT_MAX_LENGTH = 800;

/** `log.set` surface used by createAILogger. */
export interface AiLoggerSink {
  readonly set: (data: Record<string, unknown>) => void;
}

/**
 * Per-turn model wrapper: tokens, tools, steps, and free-form text (`ai.output`)
 * merge into the request wide event. Fresh wrap each turn (DO-safe).
 */
export function wrapModelWithAiLogger(
  model: LanguageModel,
  log: AiLoggerSink,
  options?: {
    readonly toolInputs?: boolean | { readonly maxLength?: number };
  }
): LanguageModel {
  const ai = createAILogger(log as RequestLogger, {
    toolInputs: options?.toolInputs ?? { maxLength: AI_LOG_TEXT_MAX_LENGTH },
  });
  return ai.wrap(model as Parameters<typeof ai.wrap>[0]) as LanguageModel;
}
