import type { Agent } from "../../../agent/core/agent";
import type { AgentHost } from "../../../execution";
import { createFileHost, type FileHostOptions } from "./file-host";

export interface NodeFileAgentContextFactoryOptions {
  readonly directory: string;
  readonly host: AgentHost;
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
  host(): AgentHost;
}

export function createNodeFileAgentContext<CreatedAgent extends Agent>({
  createAgent,
  directory,
}: NodeFileAgentContextOptions<CreatedAgent>): NodeFileAgentContext<CreatedAgent> {
  const createHost = (options: FileHostOptions) => createFileHost(options);
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
