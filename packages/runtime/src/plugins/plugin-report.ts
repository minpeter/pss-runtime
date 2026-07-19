import type { RuntimeDiagnosticsSink } from "./diagnostics";

export async function reportPluginFailure(
  diagnostics: RuntimeDiagnosticsSink,
  pluginIndex: number,
  phase: "factory" | "handler",
  cause: unknown,
  event?: string
): Promise<void> {
  try {
    await diagnostics.report({
      cause,
      code: `plugin.${phase}_failed`,
      ...(event ? { event } : {}),
      level: "error",
      phase,
      pluginIndex,
    });
  } catch {
    return;
  }
}
