import type { AgentInput } from "@minpeter/pss-runtime";
import type { ExecutionHost, RunRecord } from "@minpeter/pss-runtime/execution";

const backgroundDelegationStateKind = "background-delegation" as const;

interface BackgroundChildRunInput {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly executionHost: ExecutionHost;
  readonly ownerNamespace?: string;
  readonly parentSessionKey?: string;
  readonly prompt: AgentInput;
  readonly sessionKey: string;
  readonly subagent: string;
}

interface DurableBackgroundChildRunState {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly kind: typeof backgroundDelegationStateKind;
  readonly parentSessionKey?: string;
  readonly prompt: AgentInput;
  readonly subagent: string;
}

interface BackgroundJobLaunch {
  readonly id: string;
  readonly status: "pending";
  readonly subagent: string;
}

export function defaultChildSessionKey(
  parentAgentNamespace: string,
  parentSessionKey: string,
  subagent: string
): string {
  return `parent:${parentAgentNamespace}:${parentSessionKey}:subagent:${subagent}`;
}

export async function launchDurableBackgroundDelegation(
  input: BackgroundChildRunInput
): Promise<BackgroundJobLaunch> {
  const existingChildRun = await getBackgroundChildRun(input);
  const id =
    existingChildRun?.publicTaskId ??
    (await createDurableBackgroundTaskId({
      delegateToolCallId: input.delegateToolCallId,
      prompt: input.prompt,
      sessionKey: input.sessionKey,
    }));

  const childRun =
    existingChildRun ??
    (await getOrCreateBackgroundChildRun({
      ...input,
      publicTaskId: id,
    }));
  if (!childRun) {
    throw new Error("Failed to create background child run.");
  }

  await input.executionHost.scheduler.enqueueRun(childRun.runId);

  return {
    id,
    status: "pending",
    subagent: input.subagent,
  };
}

export function backgroundLaunchOutput(job: BackgroundJobLaunch) {
  return {
    message: [
      `백그라운드 작업 ${job.id}을(를) 시작했다.`,
      `작업 ${job.id}을(를) 확인하기 전에 <system-reminder>를 기다려라.`,
    ].join(" "),
    run_in_background: true,
    status: job.status,
    subagent: job.subagent,
    task_id: job.id,
  };
}

async function createDurableBackgroundTaskId({
  delegateToolCallId,
  prompt,
  sessionKey,
}: Pick<
  BackgroundChildRunInput,
  "delegateToolCallId" | "prompt" | "sessionKey"
>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      backgroundSubagentDedupeKey({ delegateToolCallId, prompt, sessionKey })
    )
  );
  const bytes = [...new Uint8Array(digest.slice(0, 16))];
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `bg_${hex}`;
}

async function getBackgroundChildRun(
  input: BackgroundChildRunInput
): Promise<RunRecord | undefined> {
  const dedupeKey = backgroundSubagentDedupeKey(input);
  return (
    (await input.executionHost.store.runs.getByDedupeKey(dedupeKey)) ??
    undefined
  );
}

async function getOrCreateBackgroundChildRun(
  input: BackgroundChildRunInput & { readonly publicTaskId: string }
): Promise<RunRecord | undefined> {
  const dedupeKey = backgroundSubagentDedupeKey(input);
  return await input.executionHost.store.transaction(async (tx) => {
    const existing = await tx.runs.getByDedupeKey(dedupeKey);
    if (existing) {
      return existing;
    }

    const parentRunId = input.parentSessionKey ?? input.sessionKey;
    const runtimeState = durableBackgroundChildRunState(input);
    const run: RunRecord = {
      checkpointVersion: 0,
      dedupeKey,
      kind: "user-turn",
      ...(input.ownerNamespace ? { ownerNamespace: input.ownerNamespace } : {}),
      parentRunId,
      publicTaskId: input.publicTaskId,
      rootRunId: parentRunId,
      runId: `background:${input.publicTaskId}`,
      sessionKey: `${input.sessionKey}:task:${input.publicTaskId}`,
      status: "queued",
    };
    await tx.runs.create(run);
    await tx.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        phase: "before-child-run",
        runId: run.runId,
        runtimeState,
        sessionSnapshot: {},
        version: 1,
      },
      { expectedVersion: 0 }
    );
    await tx.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        childRunId: run.runId,
        phase: "child-linked",
        runId: run.runId,
        runtimeState,
        sessionSnapshot: {},
        version: 2,
      },
      { expectedVersion: 1 }
    );
    return (await tx.runs.get(run.runId)) ?? run;
  });
}

function durableBackgroundChildRunState(
  input: BackgroundChildRunInput
): DurableBackgroundChildRunState {
  return {
    ...(input.delegateToolCallId
      ? { delegateToolCallId: input.delegateToolCallId }
      : {}),
    ...(input.description ? { description: input.description } : {}),
    kind: backgroundDelegationStateKind,
    ...(input.parentSessionKey
      ? { parentSessionKey: input.parentSessionKey }
      : {}),
    prompt: structuredClone(input.prompt),
    subagent: input.subagent,
  };
}

function backgroundSubagentDedupeKey({
  delegateToolCallId,
  prompt,
  sessionKey,
}: {
  readonly delegateToolCallId?: string;
  readonly prompt: AgentInput;
  readonly sessionKey: string;
}): string {
  return `background-delegation:${sessionKey}:${delegateToolCallId ?? "unknown"}:${JSON.stringify(prompt)}`;
}

export function readDurableBackgroundDelegationState(
  checkpoint: { readonly runtimeState: unknown } | null
): DurableBackgroundChildRunState | null {
  const state = checkpoint?.runtimeState;
  if (
    !isRecord(state) ||
    state.kind !== backgroundDelegationStateKind ||
    !isAgentInput(state.prompt) ||
    typeof state.subagent !== "string"
  ) {
    return null;
  }

  return {
    ...(typeof state.delegateToolCallId === "string"
      ? { delegateToolCallId: state.delegateToolCallId }
      : {}),
    ...(typeof state.description === "string"
      ? { description: state.description }
      : {}),
    kind: backgroundDelegationStateKind,
    ...(typeof state.parentSessionKey === "string"
      ? { parentSessionKey: state.parentSessionKey }
      : {}),
    prompt: state.prompt,
    subagent: state.subagent,
  };
}

function isAgentInput(value: unknown): value is AgentInput {
  if (typeof value === "string" || Array.isArray(value)) {
    return true;
  }

  return (
    isRecord(value) &&
    (value.type === "user-text" || value.type === "user-message")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
