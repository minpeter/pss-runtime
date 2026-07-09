import type { AgentHost } from "../../execution/host/types";
import {
  cleanupStagedRuntimeAttachments,
  type HostAttachmentStore,
  type RuntimeAttachmentReference,
  stageUserInputAttachments,
  userInputRequiresAttachmentProcessing,
} from "../input/attachments";
import type { AgentInput } from "../input/input";
import { attachInputMeta } from "../input/input-meta";
import { normalizeAgentInput } from "../input/input-normalization";
import {
  assertRuntimeInputOpen,
  currentSteeringPlacement,
  queueRuntimeInput,
  type RuntimeInputState,
} from "../input/runtime-input";
import { admitDurableThreadInput } from "../runtime/durable-inputs";

export async function addDurableSteeringInput({
  attachmentStore,
  executionHost,
  input,
  runtimeInput,
  threadKey,
}: {
  readonly attachmentStore: HostAttachmentStore | undefined;
  readonly executionHost: AgentHost | undefined;
  readonly input: AgentInput;
  readonly runtimeInput: RuntimeInputState;
  readonly threadKey: string;
}): Promise<void> {
  const placement = currentSteeringPlacement(runtimeInput);
  const next = runtimeInput.pending.then(async () => {
    const stagedRefs: RuntimeAttachmentReference[] = [];
    let keepStagedAttachments = false;
    assertRuntimeInputOpen(runtimeInput);
    const acceptedInput = attachInputMeta(normalizeAgentInput(input), {
      source: "steer",
      streaming: "steer",
    });
    try {
      const stagedInput = userInputRequiresAttachmentProcessing(acceptedInput)
        ? await stageUserInputAttachments(acceptedInput, attachmentStore, {
            stagedRefs,
          })
        : acceptedInput;
      assertRuntimeInputOpen(runtimeInput);
      const admission = await admitDurableThreadInput({
        executionHost,
        input: stagedInput,
        kind: "steer",
        placement,
        threadKey,
      });
      if (admission.kind === "admitted") {
        keepStagedAttachments = true;
        return;
      }

      assertRuntimeInputOpen(runtimeInput);
      queueRuntimeInput(runtimeInput, {
        input: stagedInput,
        placement,
      });
      keepStagedAttachments = true;
    } finally {
      if (!keepStagedAttachments) {
        await cleanupStagedRuntimeAttachments(attachmentStore, stagedRefs);
      }
    }
  });
  runtimeInput.pending = next.catch(() => undefined);
  await next;
}
