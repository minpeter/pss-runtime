import type { UserInput } from "./input";
import { attachInputMeta } from "./input-meta";

export function delegateUserInput(
  prompt: unknown,
  options: { readonly delegateToolName?: string } = {}
): UserInput {
  if (typeof prompt !== "string") {
    throw new TypeError("Delegate prompt must be a plain string.");
  }

  return attachInputMeta(
    {
      type: "user-text",
      text: prompt,
    },
    {
      delegateToolName: options.delegateToolName,
      source: "delegate",
    }
  );
}
