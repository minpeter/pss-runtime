import { jsonSchema, type ToolSet, tool } from "ai";
import { normalizeAgentInput } from "./session/input-normalization";
import { createBackgroundCancelTool } from "./subagent-job-cancel";
import { createBackgroundOutputTool } from "./subagent-job-output";
import { startBackgroundJob } from "./subagent-jobs";
import { runBlockingDelegation, scopedChildSessionKey } from "./subagent-run";
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
      const prompt = normalizeAgentInput(input.prompt);
      const sessionKey = scopedChildSessionKey({
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
          sessionKey,
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

const delegatePromptSchema = {
  anyOf: [
    { type: "string" },
    { items: { type: "string" }, type: "array" },
    {
      additionalProperties: false,
      properties: {
        text: {
          anyOf: [
            { type: "string" },
            { items: { type: "string" }, type: "array" },
          ],
        },
        type: { const: "user-text" },
      },
      required: ["type", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        content: { type: "array" },
        type: { const: "user-message" },
      },
      required: ["type", "content"],
      type: "object",
    },
    {
      items: {
        anyOf: [
          {
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              type: { const: "text" },
            },
            required: ["type", "text"],
            type: "object",
          },
          {
            additionalProperties: false,
            properties: {
              image: { type: "string" },
              mediaType: { type: "string" },
              type: { const: "image" },
            },
            required: ["type", "image"],
            type: "object",
          },
          {
            additionalProperties: false,
            properties: {
              data: {},
              filename: { type: "string" },
              mediaType: { type: "string" },
              type: { const: "file" },
            },
            required: ["type", "data", "mediaType"],
            type: "object",
          },
        ],
      },
      type: "array",
    },
  ],
};
