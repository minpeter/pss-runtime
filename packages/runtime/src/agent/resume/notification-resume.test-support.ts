import { expect } from "vitest";
import type { ExecutionHost, RunRecord } from "../../execution/host/types";
import { createInMemoryExecutionHost } from "../../execution/memory";
import type { AgentRun } from "../../session/protocol/run";
import { agentNamespace } from "../identity/namespace";

interface ResumableAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

export function expectResumeSurface(
  agent: unknown
): asserts agent is ResumableAgent {
  expect(
    getProperty(agent, "resume"),
    "agent resume path is not available"
  ).toBeTypeOf("function");
}

export function createSessionLoadFailingHost(): ExecutionHost {
  const base = createInMemoryExecutionHost();
  return {
    ...base,
    store: {
      ...base.store,
      sessions: {
        commit: base.store.sessions.commit.bind(base.store.sessions),
        delete: base.store.sessions.delete.bind(base.store.sessions),
        load: () => Promise.reject(new Error("session load failed")),
      },
    },
  };
}

export function notificationRunRecord({
  idempotencyKey,
  ownerNamespace = agentNamespace("notify-owner"),
  runId,
}: {
  readonly idempotencyKey: string;
  readonly ownerNamespace?: string;
  readonly runId: string;
}): RunRecord {
  return {
    checkpointVersion: 0,
    dedupeKey: idempotencyKey,
    kind: "notification",
    ownerNamespace,
    rootRunId: runId,
    runId,
    threadKey: "default",
    status: "queued",
  };
}

function getProperty(value: unknown, property: "resume"): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }

  return property in value ? value[property] : undefined;
}
