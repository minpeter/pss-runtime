export type RuntimeDiagnosticLevel = "error" | "info" | "warning";

export interface RuntimeDiagnostic {
  readonly cause?: unknown;
  readonly code: string;
  readonly event?: string;
  readonly level: RuntimeDiagnosticLevel;
  readonly phase: "activation" | "factory" | "handler" | "registration";
  readonly pluginIndex?: number;
  readonly threadKey?: string;
}

export interface RuntimeDiagnosticsSink {
  report(diagnostic: RuntimeDiagnostic): Promise<void> | void;
}

export const noopRuntimeDiagnostics: RuntimeDiagnosticsSink = {
  report: () => undefined,
};
