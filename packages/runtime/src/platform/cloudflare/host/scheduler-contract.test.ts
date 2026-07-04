import { describeExecutionSchedulerContract } from "../../../contracts/execution-scheduler/contract";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareThreadPrompt,
  createCloudflareAlarmScheduler,
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
      alarmTimeMs: () => {
        const alarmTime = storage.alarmTime();
        if (alarmTime === undefined) {
          return;
        }
        return typeof alarmTime === "number" ? alarmTime : alarmTime.getTime();
      },
      listRuns: (options) =>
        listScheduledCloudflareRuns(storage, { limit: options?.limit }),
      listThreadPrompts: (options) =>
        listScheduledCloudflareThreadPrompts(storage, {
          limit: options?.limit,
        }),
      scheduler: createCloudflareAlarmScheduler({ storage }),
    };
  },
  name: "cloudflare durable object",
  supportsDueTimeFiltering: false,
});
