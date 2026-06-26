import type { Agent } from "../../../agent/core/agent";
import type { ExecutionHost } from "../../../execution";
import {
  createNodeFileExecutionHost,
  type NodeFileExecutionHostOptions,
} from "./file-execution-host";

export interface NodeFileAgentContextFactoryOptions {
  readonly directory: string;
  readonly host: ExecutionHost;
}

export interface NodeFileAgentContextOptions<CreatedAgent extends Agent> {
  readonly createAgent: (
    options: NodeFileAgentContextFactoryOptions
  ) => CreatedAgent;
  readonly directory: string;
}

export interface NodeFileAgentContext<CreatedAgent extends Agent> {
  agent(): CreatedAgent;
  readonly directory: string;
  host(): ExecutionHost;
}

export function createNodeFileAgentContext<CreatedAgent extends Agent>({
  createAgent,
  directory,
}: NodeFileAgentContextOptions<CreatedAgent>): NodeFileAgentContext<CreatedAgent> {
  const createHost = (options: NodeFileExecutionHostOptions) =>
    createNodeFileExecutionHost(options);
  const createContextHost = () => createHost({ directory });

  return {
    agent: () =>
      createAgent({
        directory,
        host: createContextHost(),
      }),
    directory,
    host: createContextHost,
  };
}
