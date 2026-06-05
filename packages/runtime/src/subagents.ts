import { jsonSchema, type ToolSet, tool } from "ai";
import {
  createBackgroundCancelTool,
  createBackgroundOutputTool,
  startBackgroundJob,
} from "./subagent-jobs";
import { defaultChildSessionKey, runBlockingDelegation } from "./subagent-run";
import type {
  CreateSubagentToolsOptions,
  DelegateInput,
  RuntimeInputSink,
  Subagent,
  SubagentJob,
} from "./subagent-types";

export function createSubagentTools({
  parentSession,
  parentSessionKey,
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
        parentSession,
        parentSessionKey,
        subagent,
      });
  }

  return generatedTools as ToolSet;
}

function createDelegateTool({
  jobs,
  parentSession,
  parentSessionKey,
  subagent,
}: {
  readonly jobs: Map<string, SubagentJob>;
  readonly parentSession: RuntimeInputSink;
  readonly parentSessionKey: string;
  readonly subagent: Subagent;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: `Delegate work to ${subagent.name}: ${subagent.description}`,
    execute: async (input: DelegateInput, { abortSignal }) => {
      const sessionKey =
        input.sessionKey ??
        defaultChildSessionKey(parentSessionKey, subagent.name ?? "subagent");
      if (input.run_in_background === true) {
        return startBackgroundJob({
          abortSignal: abortSignal ?? new AbortController().signal,
          description: input.description,
          jobs,
          parentSession,
          parentSessionKey,
          prompt: input.prompt,
          sessionKey: input.sessionKey,
          subagent,
        });
      }

      parentSession.emitObserverEvent({
        description: input.description,
        run_in_background: false,
        sessionKey,
        subagent: subagent.name ?? "subagent",
        type: "subagent-job-start",
      });
      const result = await runBlockingDelegation({
        prompt: input.prompt,
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
        prompt: {},
        run_in_background: { default: false, type: "boolean" },
        sessionKey: { type: "string" },
      },
      required: ["prompt"],
      type: "object",
    }),
  });
}
