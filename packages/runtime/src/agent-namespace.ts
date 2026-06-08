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

export function ownsAgentNamespace(
  ownerNamespace: string | undefined,
  sessionNamespace: string
): boolean {
  return (
    ownerNamespace === sessionNamespace ||
    ownerNamespace?.startsWith(`${sessionNamespace}:session:`) === true
  );
}

export function stableAgentNamespace({
  name,
  namespace,
}: {
  readonly name?: string;
  readonly namespace?: string;
}): string {
  const stableNamespace = namespace ?? name;
  return stableNamespace
    ? agentNamespace(stableNamespace)
    : randomAgentNamespace();
}
