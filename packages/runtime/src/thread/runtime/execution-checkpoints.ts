import { appendLeaseFencedCheckpoint } from "../../execution/host/checkpoint-fencing";
import { createCheckpointId } from "../../execution/host/checkpoint-ids";
import {
  type JournaledToolIntent,
  type JournaledToolResult,
  TOOL_STEP_JOURNAL_VERSION,
} from "../../execution/host/tool-step-journal";
import type {
  AgentHost,
  Checkpoint,
  CheckpointPhase,
  LeaseFencedCheckpointWriteResult,
} from "../../execution/host/types";
import { assertNever } from "../../internal/guards";
import {
  persistedToolExecutionCheckpoint,
  toolErrorText,
} from "../../llm/tool-execution-checkpoint";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
  RuntimeToolExecutionDecision,
  RuntimeToolExecutionResult,
} from "../../llm/tool-execution-types";
import type { ThreadState } from "../state/thread-state";

const maxCheckpointWriteAttempts = 5;

export type ThreadToolCallInterceptor = (
  checkpoint: RuntimeToolExecutionCheckpoint
) => Promise<RuntimeToolExecutionDecision> | RuntimeToolExecutionDecision;

export type ThreadToolResultInterceptor = (
  checkpoint: RuntimeToolExecutionCheckpoint & { readonly output: unknown }
) =>
  | Promise<RuntimeToolExecutionResult | undefined>
  | RuntimeToolExecutionResult
  | undefined;

export class ThreadExecutionCheckpointError extends Error {
  constructor(runId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Thread execution run ${runId} checkpoint conflict: expected ${expectedVersion}, got ${currentVersion}`
    );
    this.name = "ThreadExecutionCheckpointError";
  }
}

type CheckpointAuthorityConflictReason = Exclude<
  Extract<LeaseFencedCheckpointWriteResult, { readonly ok: false }>["reason"],
  "stale-version"
>;

const CHECKPOINT_AUTHORITY_CONFLICT_MESSAGES = {
  "lease-conflict": "checkpoint lease conflict.",
  "not-found": "checkpoint run is missing.",
  "status-conflict": "checkpoint status conflict: run is terminal.",
} as const satisfies Record<CheckpointAuthorityConflictReason, string>;

export class ThreadExecutionCheckpointAuthorityError extends Error {
  readonly reason: CheckpointAuthorityConflictReason;
  readonly runId: string;

  constructor(runId: string, reason: CheckpointAuthorityConflictReason) {
    super(
      `Thread execution run ${runId} ${CHECKPOINT_AUTHORITY_CONFLICT_MESSAGES[reason]}`
    );
    this.name = "ThreadExecutionCheckpointAuthorityError";
    this.reason = reason;
    this.runId = runId;
  }
}

/** A tool call whose after-tool checkpoint was persisted earlier in a run. */
export interface CompletedToolCall {
  /** Run checkpoint version of the after-tool checkpoint; unique per run. */
  readonly checkpointVersion?: number;
  /**
   * Tool-result parts with this id in the in-memory model history when the
   * result was checkpointed, before the result itself was appended. Provider
   * ids can recur, so the result counts as committed only when committed
   * history holds more. `undefined` means no evidence: unrestorable.
   */
  readonly priorResultCount?: number;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Recovery evidence recorded on a before-tool or after-tool checkpoint. */
export interface ToolCheckpointEvidence {
  /** Calls completed earlier in the run; `undefined` if never recorded. */
  readonly priorCompleted: readonly CompletedToolCall[] | undefined;
  /** The checkpoint's own call; `priorResultCount` only on after-tool. */
  readonly toolCall: CompletedToolCall;
}

type CompletedToolCallFields = Partial<
  Record<keyof CompletedToolCall | "priorCompletedToolCalls", unknown>
>;

function parseCompletedToolCall(
  entry: CompletedToolCallFields | null | undefined
): CompletedToolCall | undefined {
  if (
    !(
      typeof entry?.toolCallId === "string" &&
      typeof entry.toolName === "string"
    )
  ) {
    return;
  }
  return {
    ...(typeof entry.checkpointVersion === "number"
      ? { checkpointVersion: entry.checkpointVersion }
      : {}),
    ...(typeof entry.priorResultCount === "number"
      ? { priorResultCount: entry.priorResultCount }
      : {}),
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
  };
}

/** Evidence of a tool checkpoint; `undefined` for any other checkpoint. */
export function toolCheckpointEvidence(
  checkpoint: Checkpoint | null
): ToolCheckpointEvidence | undefined {
  if (
    checkpoint?.phase !== "before-tool" &&
    checkpoint?.phase !== "after-tool"
  ) {
    return;
  }
  const state = checkpoint.runtimeState as CompletedToolCallFields | null;
  const prior = state?.priorCompletedToolCalls;
  const pending = checkpoint.pendingToolCall as
    | CompletedToolCallFields
    | undefined;
  const own = parseCompletedToolCall(state) ??
    parseCompletedToolCall(pending) ?? {
      toolCallId: "unknown",
      toolName: "unknown",
    };
  return {
    priorCompleted: Array.isArray(prior)
      ? prior.map(
          (entry: unknown): CompletedToolCall =>
            // An unparseable entry still marks a completed call; keep it as
            // unrestorable rather than dropping it.
            parseCompletedToolCall(entry as CompletedToolCallFields | null) ?? {
              toolCallId: "unknown",
              toolName: "unknown",
            }
        )
      : undefined,
    toolCall:
      checkpoint.phase === "after-tool"
        ? { ...own, checkpointVersion: checkpoint.version }
        : {
            toolCallId: own.toolCallId,
            toolName: own.toolName,
          },
  };
}

function completedToolCallsThrough(
  checkpoint: Checkpoint | null
): CompletedToolCall[] {
  const evidence = toolCheckpointEvidence(checkpoint);
  if (!evidence) {
    return [];
  }
  return [
    ...(evidence.priorCompleted ?? []),
    ...(checkpoint?.phase === "after-tool" ? [evidence.toolCall] : []),
  ];
}

/** The outcome recovery gives a call the crashed step left unfinished. */
export type RecoveredToolOutcome =
  | { readonly errorText: string }
  | { readonly output: unknown };

/** Run tool context that journals the current step's tool round. */
export interface ThreadToolExecutionContext
  extends RuntimeToolExecutionContext {
  /**
   * Starts committing the step's tool round to thread history. Returns
   * `undefined` when the step journaled nothing; otherwise call the result
   * once the commit holds the round, which drops it from the journal.
   */
  beginToolRoundCommit(): (() => void) | undefined;
  /**
   * Carries a crashed step's unfinished calls into this attempt's journal,
   * so every checkpoint records them until each one is settled. Call it
   * before any tool of this attempt runs.
   */
  resumeToolCalls(calls: readonly JournaledToolIntent[]): void;
  /** Journals a carried call's outcome; result hooks never see it. */
  settleToolCall(
    call: JournaledToolIntent,
    outcome: RecoveredToolOutcome
  ): Promise<void>;
}

interface StepJournalState {
  readonly inflight: JournaledToolIntent[];
  readonly results: JournaledToolResult[];
  seq: number;
}

type StepJournalEntry =
  | { readonly kind: "intent" }
  | { readonly errorText?: string; readonly kind: "result" };

export function createThreadToolExecutionContext({
  executionHost,
  interceptToolCall,
  interceptToolResult,
  leaseId,
  runId,
  state,
}: {
  readonly executionHost: AgentHost;
  readonly interceptToolCall?: ThreadToolCallInterceptor;
  readonly interceptToolResult?: ThreadToolResultInterceptor;
  readonly leaseId: string | null;
  readonly runId: string;
  readonly state: ThreadState;
}): ThreadToolExecutionContext {
  // Thread history commits each tool round at step end. Until then every tool
  // checkpoint carries the step's journal (recorded intents without outcomes
  // and finished results), so a crash anywhere in the step can be resumed.
  // Each checkpoint also records the run's completed tools, which recovery
  // uses to fail closed when a result is neither committed nor journaled. A
  // recovered attempt inherits that list from the run's latest checkpoint.
  // Appends are serialized so parallel tool calls in one step each record
  // every sibling journaled before them.
  let completed: CompletedToolCall[] | undefined;
  const journal: StepJournalState = { inflight: [], results: [], seq: 0 };
  let appends: Promise<unknown> = Promise.resolve();
  const append = (
    phase: Extract<CheckpointPhase, "after-tool" | "before-tool">,
    toolCall: RuntimeToolExecutionCheckpoint & { readonly output?: unknown },
    entry: StepJournalEntry
  ): Promise<void> => {
    const appended = appends.then(async () => {
      completed ??= completedToolCallsThrough(
        await executionHost.store.checkpoints.latest(runId)
      );
      await appendThreadToolExecutionCheckpoint({
        completed,
        entry,
        executionHost,
        journal,
        leaseId,
        phase,
        runId,
        state,
        toolCall,
      });
    });
    // A failed append rejects only its own caller, never later appends.
    appends = appended.catch(() => undefined);
    return appended;
  };
  // Journal changes that write nothing still queue behind pending appends,
  // which replace the journal with what they wrote.
  const stage = (change: () => void): Promise<void> => {
    const staged = appends.then(change);
    appends = staged.catch(() => undefined);
    return staged;
  };
  return {
    attempt: 1,
    afterTool: async (checkpoint) => {
      // Recovered results never pass the result hook again, so persist only
      // its final output. A crash inside the hook leaves the intent pending.
      const transformed = await interceptToolResult?.(checkpoint);
      await append(
        "after-tool",
        {
          ...checkpoint,
          output: transformed ? transformed.output : checkpoint.output,
        },
        { kind: "result" }
      );
      return transformed;
    },
    afterToolError: async (checkpoint, error) => {
      await append(
        "after-tool",
        { ...checkpoint, output: null },
        { errorText: toolErrorText(error), kind: "result" }
      );
    },
    beforeTool: async (checkpoint) => {
      if (checkpoint.policy === "pure") {
        // A pure call has no effect to protect: its intent rides along with
        // the step's next checkpoint instead of writing one of its own.
        await stage(() =>
          applyStepJournal(
            journal,
            nextStepJournal(journal, { kind: "intent" }, checkpoint, {
              priorResultCount: 0,
              version: 0,
            })
          )
        );
      } else {
        await append("before-tool", checkpoint, { kind: "intent" });
      }
      const decision = await interceptToolCall?.(checkpoint);
      if (
        decision?.status === "needs-recovery" &&
        checkpoint.policy !== "manual-recovery"
      ) {
        await append(
          "before-tool",
          { ...checkpoint, policy: "manual-recovery" },
          { kind: "intent" }
        );
      }
      if (decision?.status === "blocked") {
        // The model receives the blocked output as this call's result.
        await append(
          "after-tool",
          { ...checkpoint, output: decision.output },
          { kind: "result" }
        );
      }
      return decision;
    },
    beginToolRoundCommit: () => {
      if (journal.inflight.length === 0 && journal.results.length === 0) {
        return;
      }
      const committing = [...journal.results];
      return () => {
        for (const result of committing) {
          const index = journal.results.indexOf(result);
          if (index >= 0) {
            journal.results.splice(index, 1);
          }
        }
      };
    },
    resumeToolCalls: (calls) => {
      stage(() => {
        journal.inflight.push(...structuredClone([...calls]));
        journal.seq = Math.max(journal.seq, ...calls.map((call) => call.seq));
      }).catch(() => undefined);
    },
    runId,
    settleToolCall: async (call, outcome) => {
      const { resolution: _resolution, seq: _seq, ...toolCall } = call;
      await append(
        "after-tool",
        { ...toolCall, output: "output" in outcome ? outcome.output : null },
        "errorText" in outcome
          ? { errorText: outcome.errorText, kind: "result" }
          : { kind: "result" }
      );
    },
  };
}

async function appendThreadToolExecutionCheckpoint({
  completed,
  entry,
  executionHost,
  journal,
  leaseId,
  phase,
  runId,
  state,
  toolCall,
}: {
  readonly completed: CompletedToolCall[];
  readonly entry: StepJournalEntry;
  readonly executionHost: AgentHost;
  readonly journal: StepJournalState;
  readonly leaseId: string | null;
  readonly phase: Extract<CheckpointPhase, "after-tool" | "before-tool">;
  readonly runId: string;
  readonly state: ThreadState;
  readonly toolCall: RuntimeToolExecutionCheckpoint & {
    readonly output?: unknown;
  };
}): Promise<void> {
  // The current call's result joins history only at step end, so this counts
  // only same-id results from earlier steps and turns.
  const priorResultCount =
    phase === "after-tool"
      ? state.history.toolResultCount(toolCall.toolCallId)
      : undefined;
  let lastConflict:
    | { readonly current: number; readonly expected: number }
    | undefined;
  for (let attempt = 0; attempt < maxCheckpointWriteAttempts; attempt += 1) {
    const run = await executionHost.store.turns.get(runId);
    if (!run) {
      throw new Error(`Thread execution run ${runId} is missing.`);
    }

    const version = run.checkpointVersion + 1;
    const next = nextStepJournal(journal, entry, toolCall, {
      priorResultCount: priorResultCount ?? 0,
      version,
    });
    const result = await appendLeaseFencedCheckpoint(
      executionHost.store,
      {
        checkpointId: createCheckpointId({ phase, runId, version }),
        pendingToolCall: persistedToolExecutionCheckpoint(toolCall),
        phase,
        runId,
        // The journal carries this call's input and output; recovery reads
        // results only from it, so the legacy copies are not repeated.
        runtimeState: {
          inflight: next.inflight,
          journalVersion: TOOL_STEP_JOURNAL_VERSION,
          priorCompletedToolCalls: [...completed],
          ...(priorResultCount === undefined ? {} : { priorResultCount }),
          results: next.results,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
        threadSnapshot: state.threadCheckpointReference(),
        version,
      },
      {
        expectedLeaseId: leaseId,
        expectedVersion: run.checkpointVersion,
      }
    );

    if (result.ok) {
      applyStepJournal(journal, next);
      if (priorResultCount !== undefined) {
        completed.push({
          checkpointVersion: version,
          priorResultCount,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        });
      }
      return;
    }

    switch (result.reason) {
      case "lease-conflict":
      case "not-found":
      case "status-conflict":
        throw new ThreadExecutionCheckpointAuthorityError(runId, result.reason);
      case "stale-version":
        lastConflict = {
          current: result.currentVersion,
          expected: run.checkpointVersion,
        };
        // Another writer advanced the run; keep its completed tools too.
        mergeCompletedToolCalls(
          completed,
          completedToolCallsThrough(
            await executionHost.store.checkpoints.latest(runId)
          )
        );
        break;
      default:
        assertNever(result);
    }
  }

  throw new ThreadExecutionCheckpointError(
    runId,
    lastConflict?.expected ?? 0,
    lastConflict?.current ?? 0
  );
}

/**
 * The journal a checkpoint would record: an intent replaces the same call's
 * earlier intent (a policy upgrade keeps its order); a result settles the
 * call's intent.
 */
function nextStepJournal(
  journal: StepJournalState,
  entry: StepJournalEntry,
  toolCall: RuntimeToolExecutionCheckpoint & { readonly output?: unknown },
  { priorResultCount, version }: { priorResultCount: number; version: number }
): {
  readonly inflight: JournaledToolIntent[];
  readonly results: JournaledToolResult[];
  readonly seq: number;
} {
  const intentIndex = journal.inflight.findIndex(
    (intent) => intent.toolCallId === toolCall.toolCallId
  );
  const intent = intentIndex >= 0 ? journal.inflight[intentIndex] : undefined;
  const seq = intent ? journal.seq : journal.seq + 1;
  const callSeq = intent?.seq ?? seq;
  const inflight = journal.inflight.filter((_, index) => index !== intentIndex);
  if (entry.kind === "intent") {
    const recorded: JournaledToolIntent = {
      attempt: toolCall.attempt,
      idempotencyKey: toolCall.idempotencyKey,
      input: intent ? intent.input : structuredClone(toolCall.input ?? {}),
      policy: toolCall.policy,
      seq: callSeq,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    };
    inflight.splice(
      intentIndex >= 0 ? intentIndex : inflight.length,
      0,
      recorded
    );
    return { inflight, results: [...journal.results], seq };
  }
  const outcome =
    entry.errorText === undefined
      ? {
          output:
            toolCall.output === undefined
              ? null
              : structuredClone(toolCall.output),
        }
      : { errorText: entry.errorText };
  return {
    inflight,
    results: [
      ...journal.results,
      {
        checkpointVersion: version,
        input: intent ? intent.input : structuredClone(toolCall.input ?? {}),
        priorResultCount,
        seq: callSeq,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        ...outcome,
      },
    ],
    seq,
  };
}

function applyStepJournal(
  journal: StepJournalState,
  next: ReturnType<typeof nextStepJournal>
): void {
  journal.inflight.splice(0, journal.inflight.length, ...next.inflight);
  journal.results.splice(0, journal.results.length, ...next.results);
  journal.seq = next.seq;
}

// Provider tool call ids can recur, so the after-tool checkpoint version
// identifies a completion.
function mergeCompletedToolCalls(
  completed: CompletedToolCall[],
  calls: readonly CompletedToolCall[]
): void {
  for (const call of calls) {
    if (
      !completed.some(
        (known) =>
          known.checkpointVersion === call.checkpointVersion &&
          known.toolCallId === call.toolCallId
      )
    ) {
      completed.push(call);
    }
  }
}
