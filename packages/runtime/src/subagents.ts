import { jsonSchema, type ToolSet, tool } from "ai";
import { normalizeAgentInput } from "./session/input-normalization";
import { createBackgroundCancelTool } from "./subagent-job-cancel";
import { createBackgroundOutputTool } from "./subagent-job-output";
import { startBackgroundJob } from "./subagent-jobs";
import { delegatePromptSchema } from "./subagent-prompt-schema";
import { runBlockingDelegation, scopedChildSessionKey } from "./subagent-run";
import type {
  CreateSubagentToolsOptions,
  DelegateInput,
  RuntimeInputSink,
  Subagent,
  SubagentJob,
} from "./subagent-types";

export function createSubagentTools({
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
  const generatedTools: Record<string, unknown> = {
    background_cancel: createBackgroundCancelTool(jobs),
    background_output: createBackgroundOutputTool(jobs),
  };

  for (const subagent of subagents) {
    const name = subagent.name;
    if (!name) {
      continue;
    }

    generatedTools[`delegate_to_${name.replaceAll("-", "_")}`] =
      createDelegateTool({
        jobs,
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
  parentAgentNamespace,
  parentSession,
  parentSessionKey,
  registerChildSession,
  subagent,
}: {
  readonly jobs: Map<string, SubagentJob>;
  readonly parentAgentNamespace: string;
  readonly parentSession: RuntimeInputSink;
  readonly parentSessionKey: string;
  readonly registerChildSession: CreateSubagentToolsOptions["registerChildSession"];
  readonly subagent: Subagent;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: `Delegate work to ${subagent.name}: ${subagent.description}`,
    execute: async (input: DelegateInput, { abortSignal }) => {
      const prompt = normalizeAgentInput(input.prompt);
      const sessionKey = scopedChildSessionKey({
        parentAgentNamespace,
        parentSessionKey,
        sessionKey: input.sessionKey,
        subagent: subagent.name ?? "subagent",
      });
      if (input.run_in_background === true) {
        return startBackgroundJob({
          abortSignal: abortSignal ?? new AbortController().signal,
          description: input.description,
          jobs,
          parentSession,
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
      parentSession.emitObserverEvent({
        description: input.description,
        run_in_background: false,
        sessionKey,
        subagent: subagent.name ?? "subagent",
        type: "subagent-job-start",
      });
      const result = await runBlockingDelegation({
        abortSignal,
        prompt,
        sessionKey,
        subagent,
      });
      parentSession.emitObserverEvent({
        error: result.error,
        eventCount: result.eventCount,
        status: result.result,
        subagent: subagent.name ?? "subagent",
        type: "subagent-job-end",
      });
      return result;
    },
    inputSchema: jsonSchema<DelegateInput>({
      additionalProperties: false,
      properties: {
        description: { type: "string" },
        prompt: delegatePromptSchema,
        run_in_background: { default: false, type: "boolean" },
        sessionKey: { type: "string" },
      },
      required: ["prompt"],
      type: "object",
    }),
  });
}
