import { type AgentOptions, createAgent } from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import { CODING_AGENT_INSTRUCTIONS } from "./instructions";
import { createCodingLanguageModel } from "./model";
import {
  type CreateCodingAgentToolsOptions,
  createCodingAgentTools,
} from "./tools";
import { createWorkspaceTools } from "./workspace-tools";

export interface CreateCodingAgentOptions {
  readonly autoCompaction?: AgentOptions["autoCompaction"];
  readonly host?: AgentOptions["host"];
  readonly instructions?: string;
  readonly model?: AgentOptions["model"];
  readonly tools?: ToolSet;
  readonly webTools?: CreateCodingAgentToolsOptions;
  readonly workspace?: string;
}

export function createCodingAgent({
  autoCompaction,
  host,
  instructions = CODING_AGENT_INSTRUCTIONS,
  model = createCodingLanguageModel(),
  tools,
  webTools,
  workspace = process.cwd(),
}: CreateCodingAgentOptions = {}) {
  const resolvedTools =
    tools ??
    ({
      ...createWorkspaceTools({ workspace }),
      ...createCodingAgentTools(webTools),
    } satisfies ToolSet);

  return createAgent({
    ...(autoCompaction === undefined ? {} : { autoCompaction }),
    ...(host === undefined ? {} : { host }),
    instructions,
    model,
    tools: resolvedTools,
  });
}
