import type { AgentInput, UserInput } from "./input";
import { attachInputMeta } from "./input-meta";
import { normalizeAgentInput } from "./input-normalization";

export function delegateUserInput(
  prompt: AgentInput,
  options: { readonly delegateToolName?: string } = {}
): UserInput {
  return attachInputMeta(normalizeAgentInput(prompt), {
    delegateToolName: options.delegateToolName,
    source: "delegate",
  });
}