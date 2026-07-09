import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareThreadPrompt,
  createCloudflareScheduledWorkScheduler,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "./durable-object-host";

describeExecutionSchedulerContract({
  createHarness: () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    return {
      ackRun: (runId) => ackScheduledCloudflareRun(storage, runId),
      ackThreadPrompt: (prompt) =>
        ackScheduledCloudflareThreadPrompt(storage, prompt),
      listRuns: (options) =>
        listScheduledCloudflareRuns(storage, { limit: options?.limit }),
      listThreadPrompts: (options) =>
        listScheduledCloudflareThreadPrompts(storage, {
          limit: options?.limit,
        }),
      scheduler: createCloudflareScheduledWorkScheduler({ storage }),
    };
  },
  name: "cloudflare durable object",
  supportsDueTimeFiltering: false,
});
