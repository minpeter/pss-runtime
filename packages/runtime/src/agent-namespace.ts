export function randomAgentNamespace(): string {
  return agentNamespace(crypto.randomUUID());
}

export function agentNamespace(namespace: string): string {
  return `agent:${namespacePart(namespace)}`;
}

export function namespacePart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Stable, encoded owner namespace for a parent agent that runs delegation tools.
 *
 * Apps that delegate to child agents (sync or background) need a stable string
 * to tag the parent run so child background runs can be owned by, and resumed
 * back into, the right parent namespace. Build it once per (agent namespace,
 * session key) pair and reuse it when constructing delegation tools.
 *
 * The result is URL-safe (each part is percent-encoded) and has no relationship
 * to the runtime-internal `agent:` namespace format used by `Agent`.
 */
export function parentSessionNamespace(
  agentNamespace: string,
  sessionKey: string
): string {
  return `app:${namespacePart(agentNamespace)}:${namespacePart(sessionKey)}`;
}

/**
 * Deterministic child session key for a delegated child agent.
 *
 * Combine the parent's owner namespace (`parentSessionNamespace`), the parent
 * session key, and the child agent name so the same delegation always maps to
 * the same child session transcript.
 */
export function defaultChildSessionKey(
  parentAgentNamespace: string,
  parentSessionKey: string,
  childName: string
): string {
  return `parent:${namespacePart(parentAgentNamespace)}:${namespacePart(
    parentSessionKey
  )}:subagent:${namespacePart(childName)}`;
}

export function durableParentSessionNamespace({
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
  namespace,
}: {
  readonly namespace?: string;
}): string {
  return namespace ? agentNamespace(namespace) : randomAgentNamespace();
}
