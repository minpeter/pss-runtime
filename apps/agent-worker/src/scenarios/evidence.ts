export interface LongRunningPingPongBoundaryEvidence {
  readonly index: number;
  readonly queuedAfter: number;
  readonly queuedBefore: number;
  readonly resumedRuns: readonly string[];
  readonly scheduledByResume: readonly string[];
}

export interface LongRunningPingPongEvidence {
  readonly boundaries: readonly LongRunningPingPongBoundaryEvidence[];
  readonly clock: "compressed";
  readonly remainingRuns: number;
  readonly simulatedElapsedMs: number;
  readonly type: "long-running-pingpong";
}

export interface UserSandboxFileEditEvidence {
  readonly after: string;
  readonly before: string | null;
  readonly editedFile: string;
  readonly isolationProbe: {
    readonly otherUserCanReadFile: boolean;
    readonly otherUserSandboxId: string;
  };
  readonly sandboxBackend: "durable-object-storage-simulation";
  readonly sandboxId: string;
  readonly type: "user-sandbox-file-edit";
}

export type StressScenarioEvidence =
  | LongRunningPingPongEvidence
  | UserSandboxFileEditEvidence;
