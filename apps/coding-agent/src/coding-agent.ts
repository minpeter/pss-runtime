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
  /**
   * Replaces the default optional web tools. Workspace tools are always
   * included and win name collisions, so custom tools cannot shadow them.
   * This factory always grants workspace file/shell access; build restricted
   * agents on `createAgent` from @minpeter/pss-runtime instead.
   */
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
  const resolvedTools = {
    ...(tools ?? createCodingAgentTools(webTools)),
    ...createWorkspaceTools({ workspace }),
  } satisfies ToolSet;

  return createAgent({
    ...(autoCompaction === undefined ? {} : { autoCompaction }),
    ...(host === undefined ? {} : { host }),
    instructions,
    model,
    tools: resolvedTools,
  });
}
