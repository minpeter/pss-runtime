import {
  type AgentHooks,
  type AgentOptions,
  createAgent,
} from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import { composeAgentHooks } from "./extensions/compose-hooks";
import type { CodingAgentExtensionHost } from "./extensions/host";
import { CODING_AGENT_INSTRUCTIONS } from "./instructions";
import { createCodingLanguageModel } from "./model";
import {
  type CreateCodingAgentToolsOptions,
  createCodingAgentTools,
} from "./tools";
import { createWorkspaceTools } from "./workspace-tools";

export interface CreateCodingAgentOptions {
  readonly autoCompaction?: AgentOptions["autoCompaction"];
  readonly extensionHost?: CodingAgentExtensionHost;
  readonly hooks?: AgentHooks;
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
  extensionHost,
  host,
  hooks,
  instructions = CODING_AGENT_INSTRUCTIONS,
  model = createCodingLanguageModel(),
  tools,
  webTools,
  workspace = process.cwd(),
}: CreateCodingAgentOptions = {}) {
  const selectedTools = tools ?? createCodingAgentTools(webTools);
  const extensionTools = extensionHost?.tools ?? {};
  const workspaceTools = createWorkspaceTools({ workspace });
  assertNoToolCollisions(selectedTools, extensionTools, workspaceTools);
  const resolvedTools = {
    ...selectedTools,
    ...extensionTools,
    ...workspaceTools,
  } satisfies ToolSet;
  const instructionFragments = extensionHost?.instructionFragments ?? [];
  const hookRegistrations = [
    ...(hooks ? [{ extensionId: "coding-agent", hooks }] : []),
    ...(extensionHost?.hooks
      ? [{ extensionId: "coding-agent-extensions", hooks: extensionHost.hooks }]
      : []),
  ];

  return createAgent({
    ...(autoCompaction === undefined ? {} : { autoCompaction }),
    ...(host === undefined ? {} : { host }),
    hooks:
      hookRegistrations.length === 0
        ? undefined
        : composeAgentHooks(hookRegistrations),
    instructions: [instructions, ...instructionFragments].join("\n\n"),
    model,
    ...(extensionHost
      ? { threadMigrations: extensionHost.threadMigrations }
      : {}),
    tools: resolvedTools,
  });
}

function assertNoToolCollisions(...toolSets: readonly ToolSet[]): void {
  const names = new Set<string>();
  for (const tools of toolSets) {
    for (const name of Object.keys(tools)) {
      if (names.has(name)) {
        throw new Error(`Duplicate coding agent tool "${name}"`);
      }
      names.add(name);
    }
  }
}
