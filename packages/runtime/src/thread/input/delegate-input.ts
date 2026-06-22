import type { AgentInput } from "./input";

export function delegateUserInput(prompt: unknown): AgentInput {
  if (typeof prompt !== "string") {
    throw new TypeError("Delegate prompt must be a plain string.");
  }

  return prompt;
}
