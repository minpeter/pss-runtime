export function randomAgentNamespace(): string {
  return agentNamespace(crypto.randomUUID());
}

export function agentNamespace(namespace: string): string {
  return `agent:${namespacePart(namespace)}`;
}

export function namespacePart(value: string): string {
  return encodeURIComponent(value);
}

export function parentSessionNamespace({
  generation,
  sessionKey,
  sessionNamespace,
}: {
  readonly generation: number;
  readonly sessionKey: string;
  readonly sessionNamespace: string;
}): string {
  return `${sessionNamespace}:session:${namespacePart(
    sessionKey
  )}:generation:${generation}`;
}
