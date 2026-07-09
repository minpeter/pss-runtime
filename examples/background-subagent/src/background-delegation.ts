import type { AgentInput } from "@minpeter/pss-runtime";
import type { AgentHost, TurnRecord } from "@minpeter/pss-runtime/execution";

const backgroundDelegationStateKind = "background-delegation" as const;

interface BackgroundChildRunInput {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly executionHost: AgentHost;
  readonly ownerNamespace?: string;
  readonly parentThreadKey?: string;
  readonly prompt: AgentInput;
  readonly subagent: string;
  readonly threadKey: string;
}

interface DurableBackgroundChildRunState {
  readonly delegateToolCallId?: string;
  readonly description?: string;
  readonly kind: typeof backgroundDelegationStateKind;
  readonly parentThreadKey?: string;
  readonly prompt: AgentInput;
  readonly subagent: string;
}

interface BackgroundJobLaunch {
  readonly id: string;
  readonly status: "pending";
  readonly subagent: string;
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
      threadKey: input.threadKey,
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
  threadKey,
}: Pick<
  BackgroundChildRunInput,
  "delegateToolCallId" | "prompt" | "threadKey"
>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      backgroundSubagentDedupeKey({ delegateToolCallId, prompt, threadKey })
    )
  );
  const bytes = [...new Uint8Array(digest.slice(0, 16))];
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `bg_${hex}`;
}

async function getBackgroundChildRun(
  input: BackgroundChildRunInput
): Promise<TurnRecord | undefined> {
  const dedupeKey = backgroundSubagentDedupeKey(input);
  return (
    (await input.executionHost.store.turns.getByDedupeKey(dedupeKey)) ??
    undefined
  );
}

async function getOrCreateBackgroundChildRun(
  input: BackgroundChildRunInput & { readonly publicTaskId: string }
): Promise<TurnRecord | undefined> {
  const dedupeKey = backgroundSubagentDedupeKey(input);
  return await input.executionHost.store.transaction(async (tx) => {
    const existing = await tx.turns.getByDedupeKey(dedupeKey);
    if (existing) {
      return existing;
    }

    const parentRunId = input.parentThreadKey ?? input.threadKey;
    const runtimeState = durableBackgroundChildRunState(input);
    const run: TurnRecord = {
      checkpointVersion: 0,
      dedupeKey,
      kind: "user-turn",
      ...(input.ownerNamespace ? { ownerNamespace: input.ownerNamespace } : {}),
      parentRunId,
      publicTaskId: input.publicTaskId,
      rootRunId: parentRunId,
      runId: `background:${input.publicTaskId}`,
      threadKey: `${input.threadKey}:task:${input.publicTaskId}`,
      status: "queued",
    };
    await tx.turns.create(run);
    await tx.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        phase: "before-child-run",
        runId: run.runId,
        runtimeState,
        threadSnapshot: {},
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
        threadSnapshot: {},
        version: 2,
      },
      { expectedVersion: 1 }
    );
    return (await tx.turns.get(run.runId)) ?? run;
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
    ...(input.parentThreadKey
      ? { parentThreadKey: input.parentThreadKey }
      : {}),
    prompt: structuredClone(input.prompt),
    subagent: input.subagent,
  };
}

function backgroundSubagentDedupeKey({
  delegateToolCallId,
  prompt,
  threadKey,
}: {
  readonly delegateToolCallId?: string;
  readonly prompt: AgentInput;
  readonly threadKey: string;
}): string {
  return `background-delegation:${threadKey}:${delegateToolCallId ?? "unknown"}:${JSON.stringify(prompt)}`;
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
    ...(typeof state.parentThreadKey === "string"
      ? { parentThreadKey: state.parentThreadKey }
      : {}),
    prompt: state.prompt,
    subagent: state.subagent,
  };
}

function isAgentInput(value: unknown): value is AgentInput {
  return typeof value === "string" || Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
