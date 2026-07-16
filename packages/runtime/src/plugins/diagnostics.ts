export type RuntimeDiagnosticLevel = "error" | "info" | "warning";

export interface ModelToolCacheFingerprintMetadata {
  readonly activeToolCount: number;
  readonly activeToolsFingerprint: string;
  readonly alwaysActiveToolCount: number;
  readonly orderedToolNamesFingerprint: string;
  readonly registeredToolCount: number;
  readonly registryToolNamesFingerprint: string;
  readonly runtimeStepIndex: number;
}

export interface RuntimeDiagnostic {
  readonly cause?: unknown;
  readonly code: string;
  readonly event?: string;
  readonly level: RuntimeDiagnosticLevel;
  readonly metadata?: ModelToolCacheFingerprintMetadata;
  readonly phase:
    | "activation"
    | "factory"
    | "handler"
    | "model-step"
    | "registration";
  readonly pluginIndex?: number;
  readonly threadKey?: string;
}

export interface RuntimeDiagnosticsSink {
  report(diagnostic: RuntimeDiagnostic): Promise<void> | void;
}

export const noopRuntimeDiagnostics: RuntimeDiagnosticsSink = {
  report: () => undefined,
};
