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
 * thread key) pair and reuse it when constructing delegation tools.
 *
 * The result is URL-safe (each part is percent-encoded) and has no relationship
 * to the runtime-internal `agent:` namespace format used by `Agent`.
 */
export function parentThreadNamespace(
  agentNamespace: string,
  threadKey: string
): string {
  return `app:${namespacePart(agentNamespace)}:${namespacePart(threadKey)}`;
}

/**
 * Deterministic child thread key for a delegated child agent.
 *
 * Combine the parent's owner namespace (`parentThreadNamespace`), the parent
 * thread key, and the child agent name so the same delegation always maps to
 * the same child thread transcript.
 */
export function defaultChildThreadKey(
  parentAgentNamespace: string,
  parentThreadKey: string,
  childName: string
): string {
  return `parent:${namespacePart(parentAgentNamespace)}:${namespacePart(
    parentThreadKey
  )}:subagent:${namespacePart(childName)}`;
}

export function durableParentThreadNamespace({
  agentOwnerNamespace,
  generation,
  threadKey,
}: {
  readonly agentOwnerNamespace: string;
  readonly generation: number;
  readonly threadKey: string;
}): string {
  return `${agentOwnerNamespace}:thread:${namespacePart(
    threadKey
  )}:generation:${generation}`;
}

export function ownsAgentNamespace(
  ownerNamespace: string | undefined,
  agentOwnerNamespace: string
): boolean {
  return (
    ownerNamespace === agentOwnerNamespace ||
    ownerNamespace?.startsWith(`${agentOwnerNamespace}:thread:`) === true ||
    ownerNamespace?.startsWith(`${agentOwnerNamespace}:session:`) === true
  );
}

export function stableAgentNamespace({
  namespace,
}: {
  readonly namespace?: string;
}): string {
  return namespace ? agentNamespace(namespace) : randomAgentNamespace();
}
