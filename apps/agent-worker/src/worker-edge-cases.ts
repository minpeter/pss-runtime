import {
  checkFailedAlarmKeepsRunScheduled,
  checkUnclaimableRunKeepsRunScheduled,
  checkUnclaimableSessionPromptKeepsPromptScheduled,
} from "./worker-edge-alarm-checks";
import {
  checkCancelledRunNotification,
  checkDuplicateAlarmDelivery,
  checkMalformedSessionPrompt,
  checkStaleCheckpoint,
} from "./worker-edge-durable-checks";

const results = {
  cancelledRunSkippedNotification: await checkCancelledRunNotification(),
  duplicateAlarmIdempotent: await checkDuplicateAlarmDelivery(),
  failedAlarmKeepsRunScheduled: await checkFailedAlarmKeepsRunScheduled(),
  malformedSessionPromptRejected: await checkMalformedSessionPrompt(),
  staleCheckpointRejected: await checkStaleCheckpoint(),
  unclaimableRunKeepsRunScheduled: await checkUnclaimableRunKeepsRunScheduled(),
  unclaimableSessionPromptKeepsPromptScheduled:
    await checkUnclaimableSessionPromptKeepsPromptScheduled(),
};

for (const [name, passed] of Object.entries(results)) {
  console.log({ [name]: passed });
}

if (!Object.values(results).every(Boolean)) {
  throw new Error("Cloudflare edge-case checks failed.");
}
