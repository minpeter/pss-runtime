import { jsonSchema, type ToolSet, tool } from "ai";
import { resolveSubagentDelegateToolName } from "./agent-validation";
import type { ExecutionHost } from "./execution/types";
import { delegateUserInput } from "./session/delegate-input";
import {
  type BlockingSubagentRunCache,
  blockingSubagentDedupeKey,
  runBlockingChild,
} from "./subagent-child-run";
import { createBackgroundCancelTool } from "./subagent-job-cancel";
import { createBackgroundOutputTool } from "./subagent-job-output";
import { startBackgroundJob } from "./subagent-jobs";
import { delegatePromptSchema } from "./subagent-prompt-schema";
import { scopedChildSessionKey } from "./subagent-run";
import type {
  CreateSubagentToolsOptions,
  DelegateInput,
  RuntimeInputSink,
  Subagent,
  SubagentJob,
  SubagentJobGroup,
} from "./subagent-types";

export function createSubagentTools({
  backgroundSubagents,
  executionHost,
  parentAgentNamespace,
  parentSession,
  parentSessionKey,
  registerChildSession,
  subagents,
}: CreateSubagentToolsOptions): ToolSet {
  if (subagents.length === 0) {
    return {};
  }

  const jobs = new Map<string, SubagentJob>();
  const groups = new Map<string, SubagentJobGroup>();
  const blockingRuns: BlockingSubagentRunCache = new Map();
  const backgroundToolScope = {
    childSessionKeyPrefix: `parent:${parentAgentNamespace}:${parentSessionKey}:subagent:`,
  };
  const generatedTools: Record<string, unknown> = backgroundSubagents
    ? {
        background_cancel: createBackgroundCancelTool(
          jobs,
          executionHost,
          backgroundToolScope
        ),
        background_output: createBackgroundOutputTool(
          jobs,
          executionHost,
          backgroundToolScope
        ),
      }
    : {};

  for (const subagent of subagents) {
    const name = subagent.name;
    if (!name) {
      continue;
    }

    generatedTools[resolveSubagentDelegateToolName(subagent)] =
      createDelegateTool({
        jobs,
        groups,
        backgroundSubagents,
        blockingRuns,
        executionHost,
        parentAgentNamespace,
        parentSession,
        parentSessionKey,
        registerChildSession,
        subagent,
      });
  }

  return generatedTools as ToolSet;
}

function createDelegateTool({
  jobs,
  groups,
  backgroundSubagents,
  blockingRuns,
  executionHost,
  parentAgentNamespace,
  parentSession,
  parentSessionKey,
  registerChildSession,
  subagent,
}: {
  readonly jobs: Map<string, SubagentJob>;
  readonly groups: Map<string, SubagentJobGroup>;
  readonly backgroundSubagents: boolean;
  readonly blockingRuns: BlockingSubagentRunCache;
  readonly executionHost?: ExecutionHost;
  readonly parentAgentNamespace: string;
  readonly parentSession: RuntimeInputSink;
  readonly parentSessionKey: string;
  readonly registerChildSession: CreateSubagentToolsOptions["registerChildSession"];
  readonly subagent: Subagent;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: `Delegate work to ${subagent.name}: ${subagent.description}`,
    execute: async (input: DelegateInput, { abortSignal, toolCallId }) => {
      const prompt = delegateUserInput(input.prompt, {
        delegateToolName: subagent.delegateToolName,
      });
      const sessionKey = scopedChildSessionKey({
        parentAgentNamespace,
        parentSessionKey,
        sessionKey: input.sessionKey,
        subagent: subagent.name ?? "subagent",
      });
      if (input.run_in_background === true) {
        if (!backgroundSubagents) {
          throw new Error(
            "Background subagent delegation is not available for this host."
          );
        }

        return await startBackgroundJob({
          abortSignal: abortSignal ?? new AbortController().signal,
          description: input.description,
          executionHost,
          groupId: parentSession.currentBackgroundGroupId?.(),
          groups,
          jobs,
          delegateToolCallId: toolCallId,
          parentSession,
          parentRunId: parentSession.currentRunId?.() ?? parentAgentNamespace,
          parentSessionKey,
          ownerNamespace: parentAgentNamespace,
          prompt,
          registerCleanup: (cleanup) =>
            registerChildSession(parentSessionKey, cleanup),
          sessionKey,
          subagent,
        });
      }

      registerChildSession(parentSessionKey, () =>
        subagent.session(sessionKey).delete()
      );
      await parentSession.emitObserverEvent({
        description: input.description,
        delegateToolCallId: toolCallId,
        run_in_background: false,
        subagent: subagent.name ?? "subagent",
        type: "subagent-job-start",
      });
      const dedupeKey = blockingSubagentDedupeKey(
        parentAgentNamespace,
        toolCallId
      );
      const existing = blockingRuns.get(dedupeKey);
      const result =
        existing ??
        runBlockingChild({
          abortSignal,
          dedupeKey,
          executionHost,
          parentRunId: parentSession.currentRunId?.() ?? parentAgentNamespace,
          prompt,
          sessionKey,
          subagent,
        });
      blockingRuns.set(dedupeKey, result);
      const awaitedResult = await result;
      await parentSession.emitObserverEvent({
        error: awaitedResult.error,
        eventCount: awaitedResult.eventCount,
        delegateToolCallId: toolCallId,
        status: awaitedResult.result,
        subagent: subagent.name ?? "subagent",
        type: "subagent-job-end",
      });
      return awaitedResult;
    },
    inputSchema: jsonSchema<DelegateInput>({
      additionalProperties: false,
      properties: createDelegateToolProperties(backgroundSubagents),
      required: ["prompt"],
      type: "object",
    }),
  });
}

function createDelegateToolProperties(backgroundSubagents: boolean) {
  const baseProperties = {
    description: { type: "string" },
    prompt: delegatePromptSchema,
    sessionKey: { type: "string" },
  };

  if (!backgroundSubagents) {
    return baseProperties;
  }

  return {
    ...baseProperties,
    run_in_background: { default: false, type: "boolean" },
  };
}
