import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import { createFileScheduler } from "./file-host";
import {
  ackScheduledNodeRun,
  ackScheduledNodeThreadPrompt,
  listScheduledNodeRuns,
  listScheduledNodeThreadPrompts,
} from "./scheduled-work-store";

describeExecutionSchedulerContract({
  createHarness: async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "pss-runtime-scheduler-contract-")
    );
    return {
      ackRun: (runId) => ackScheduledNodeRun(directory, runId),
      ackThreadPrompt: (prompt) =>
        ackScheduledNodeThreadPrompt(directory, prompt),
      cleanup: () => rm(directory, { force: true, recursive: true }),
      listRuns: (options) => listScheduledNodeRuns(directory, options),
      listThreadPrompts: (options) =>
        listScheduledNodeThreadPrompts(directory, options),
      scheduler: createFileScheduler({ directory }),
    };
  },
  name: "node file",
  supportsDueTimeFiltering: true,
});
