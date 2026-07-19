import type { ToolSet } from "ai";

export function assertNoUnsupportedToolApproval(
  tools: ToolSet | undefined
): void {
  if (!tools) {
    return;
  }

  for (const toolName of Object.keys(tools)) {
    const descriptor = Object.getOwnPropertyDescriptor(tools, toolName);
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(`Agent tools.${toolName} must be a data property.`);
    }
    const toolDefinition = descriptor.value;
    if (
      (typeof toolDefinition === "object" ||
        typeof toolDefinition === "function") &&
      toolDefinition !== null &&
      "needsApproval" in toolDefinition
    ) {
      throw new TypeError(
        `Agent tools.${toolName}.needsApproval is not supported. ` +
          "Use the pss tool.call.before checkpoint recovery hook instead of AI SDK tool approval."
      );
    }
  }
}
