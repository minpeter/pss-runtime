import {
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
  userInputContainsRuntimeAttachmentRefs,
  userInputRequiresAttachmentStaging,
} from "../input/attachments";
import type { AgentInput } from "../input/input";
import { attachInputMeta } from "../input/input-meta";
import { normalizeAgentInput } from "../input/input-normalization";
import type { QueuedRuntimeInput } from "../input/runtime-input";

export function createOverlayRuntimeInput(
  input: AgentInput
): QueuedRuntimeInput {
  const normalized = attachInputMeta(normalizeAgentInput(input), {
    source: "overlay",
  });
  if (userInputContainsRuntimeAttachmentRefs(normalized)) {
    throw new RuntimeAttachmentSecurityError(
      "External input cannot contain runtime attachment refs."
    );
  }
  if (userInputRequiresAttachmentStaging(normalized)) {
    throw new RuntimeAttachmentStagingError(
      "thread.overlay() cannot accept inline file bytes because overlay() is synchronous."
    );
  }

  return {
    canonical: false,
    input: normalized,
    placement: "turn-start",
  };
}
