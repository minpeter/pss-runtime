import type { ToolSet } from "ai";

export function assertNoUnsupportedToolApproval(
  tools: ToolSet | undefined
): void {
  if (!tools) {
    return;
  }

  for (const [toolName, toolDefinition] of Object.entries(tools)) {
    if (
      (typeof toolDefinition === "object" ||
        typeof toolDefinition === "function") &&
      toolDefinition !== null &&
      "needsApproval" in toolDefinition
    ) {
      throw new TypeError(
        `Agent tools.${toolName}.needsApproval is not supported. ` +
          "Use pss before-tool-call checkpoint recovery instead of AI SDK tool approval."
      );
    }
  }
}
