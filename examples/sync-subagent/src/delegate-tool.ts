import {
  delegateUserInput,
  type Agent,
  type AgentInput,
  type AgentRun,
} from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";

export const delegateToolName = "delegate_to_reader";
export const readerChildName = "reader";

interface DelegateInput {
  readonly prompt: string;
}

export function parentSessionNamespace(
  agentNamespace: string,
  sessionKey: string
): string {
  const sessionNamespace = `agent:${encodeURIComponent(agentNamespace)}`;
  return `${sessionNamespace}:session:${encodeURIComponent(sessionKey)}:generation:0`;
}

export function defaultChildSessionKey(
  parentAgentNamespace: string,
  parentSessionKey: string,
  childName: string
): string {
  return `parent:${parentAgentNamespace}:${parentSessionKey}:subagent:${childName}`;
}

export function createDelegateToReaderTool(options: {
  readonly description: string;
  readonly parentAgentNamespace: string;
  readonly parentSessionKey: string;
  readonly readerAgent: Agent;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: options.description,
    execute: async (input, { abortSignal }) => {
      if (abortSignal?.aborted) {
        throw new Error("Delegation was aborted before it started.");
      }

      const prompt = delegateUserInput(input.prompt, { delegateToolName });
      const childSessionKey = defaultChildSessionKey(
        options.parentAgentNamespace,
        options.parentSessionKey,
        readerChildName
      );

      return await runBlockingDelegation({
        abortSignal,
        prompt,
        readerAgent: options.readerAgent,
        sessionKey: childSessionKey,
      });
    },
    inputSchema: jsonSchema<DelegateInput>({
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description:
            "reader 에이전트에 전달할 작업 프롬프트. 반드시 단일 문자열이어야 한다.",
        },
      },
      required: ["prompt"],
      type: "object",
    }),
  });
}

async function runBlockingDelegation({
  abortSignal,
  prompt,
  readerAgent,
  sessionKey,
}: {
  readonly abortSignal?: AbortSignal;
  readonly prompt: AgentInput;
  readonly readerAgent: Agent;
  readonly sessionKey: string;
}) {
  const childSession = readerAgent.session(sessionKey);
  if (abortSignal?.aborted) {
    return {
      result: "aborted" as const,
      subagent: readerChildName,
      text: "",
    };
  }

  const abort = () => childSession.interrupt();
  abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    const text = await collectAssistantText(await childSession.send(prompt));
    return {
      result: "completed" as const,
      subagent: readerChildName,
      text,
    };
  } finally {
    abortSignal?.removeEventListener("abort", abort);
  }
}

async function collectAssistantText(run: AgentRun) {
  let text = "";
  for await (const event of run.events()) {
    if (event.type === "assistant-text") {
      text += event.text;
    }
  }
  return text;
}