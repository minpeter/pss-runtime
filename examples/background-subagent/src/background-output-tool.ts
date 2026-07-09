import type { AgentHost, TurnStatus } from "@minpeter/pss-runtime/execution";
import { jsonSchema, tool } from "ai";
import { readDurableBackgroundDelegationState } from "./background-delegation";
import { readerChildName } from "./delegate-tool";

interface BackgroundOutputInput {
  readonly task_id: string;
}

export function createBackgroundOutputTool({
  executionHost,
  ownerNamespace,
  parentThreadKey,
}: {
  readonly executionHost: AgentHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
}) {
  return tool<BackgroundOutputInput, unknown, Record<string, unknown>>({
    description: "백그라운드 reader 작업의 결과를 가져온다.",
    execute: async ({ task_id }) => {
      const record = await executionHost.store.turns.get(
        `background:${task_id}`
      );
      if (!record || record.publicTaskId !== task_id) {
        throw new Error(`알 수 없는 백그라운드 작업 ${task_id}.`);
      }
      const checkpoint = await executionHost.store.checkpoints.latest(
        record.runId
      );
      const state = readDurableBackgroundDelegationState(checkpoint);
      if (
        record.ownerNamespace !== ownerNamespace ||
        state?.parentThreadKey !== parentThreadKey ||
        state.subagent !== readerChildName
      ) {
        throw new Error(`백그라운드 작업 ${task_id}에 접근할 수 없다.`);
      }

      return {
        result: record.output,
        status: normalizeStatus(record.status),
        subagent: readerChildName,
        task_id,
      };
    },
    inputSchema: jsonSchema<BackgroundOutputInput>({
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
      type: "object",
    }),
  });
}

function normalizeStatus(status: TurnStatus): string {
  if (status === "completed" || status === "cancelled" || status === "error") {
    return status;
  }

  if (status === "running" || status === "leased") {
    return "running";
  }

  return "pending";
}
