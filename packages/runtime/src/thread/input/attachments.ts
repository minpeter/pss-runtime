import type { AgentEvent, RuntimeInput } from "../protocol/events";
import { decodeRuntimeAttachmentData } from "./attachment-refs";
import { runtimeAttachmentDataRef } from "./attachment-staging-data";
import { stageUserInputAttachments } from "./attachment-staging-input";
import type {
  HostAttachmentStore,
  RuntimeAttachmentReference,
  RuntimeAttachmentStagingOptions,
} from "./attachment-types";
import type { UserInput } from "./input";

// biome-ignore-all lint/performance/noBarrelFile: Stable internal import surface for attachment helpers split by responsibility.

export { hydrateRuntimeAttachments } from "./attachment-hydration";
export {
  getInstalledImageCodecWasm,
  type ImageCodecWasmModules,
  installImageCodecWasm,
  installImageCodecWasmFromNodeModules,
} from "./attachment-image-codec-registry";
export {
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  IMAGE_PREPARE_LOG_MESSAGE,
  type ImageOmitDiagnosticsListener,
  type ImagePrepareDiagnosticsListener,
  isCompressibleImageMediaType,
  isStoredImageMediaType,
  MAX_IMAGE_DECODED_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_STORAGE_BUDGET_BYTES,
  notifyImageOmitDiagnostics,
  type PreparedAttachmentBytes,
  prepareAttachmentBytesForStorage,
  runWithImageOmitDiagnosticsListener,
  runWithImagePrepareDiagnosticsListener,
  STORED_IMAGE_MEDIA_TYPES,
  type StoredImageMediaType,
} from "./attachment-image-compress";
export {
  decodeRuntimeAttachmentData,
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
export {
  stageUserInputAttachments,
  userInputContainsRuntimeAttachmentRefs,
  userInputRequiresAttachmentProcessing,
  userInputRequiresAttachmentStaging,
} from "./attachment-staging-input";
export {
  type HostAttachmentStore,
  type ImageOmitDiagnostics,
  type ImagePrepareDiagnostics,
  type ImagePreparePath,
  type RuntimeAttachmentBlob,
  RuntimeAttachmentHydrationError,
  RuntimeAttachmentImageLimitError,
  type RuntimeAttachmentPutInput,
  type RuntimeAttachmentReference,
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
  type RuntimeAttachmentStagingOptions,
} from "./attachment-types";

export async function cleanupStagedRuntimeAttachments(
  store: HostAttachmentStore | undefined,
  refs: readonly RuntimeAttachmentReference[]
): Promise<void> {
  if (!store || refs.length === 0) {
    return;
  }

  await Promise.allSettled([...refs].reverse().map((ref) => store.delete(ref)));
}

export async function cleanupUnreferencedStagedRuntimeAttachments(
  store: HostAttachmentStore | undefined,
  refs: readonly RuntimeAttachmentReference[],
  retained: readonly (AgentEvent | UserInput)[]
): Promise<void> {
  const retainedRefs = new Set<string>();
  for (const value of retained) {
    for (const ref of runtimeAttachmentRefs(value)) {
      retainedRefs.add(runtimeAttachmentRefKey(ref));
    }
  }

  await cleanupStagedRuntimeAttachments(
    store,
    refs.filter((ref) => !retainedRefs.has(runtimeAttachmentRefKey(ref)))
  );
}

export async function stageAgentEventAttachments(
  event: AgentEvent,
  store: HostAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions = {}
): Promise<AgentEvent> {
  if (event.type === "user-input") {
    return stageUserInputAttachments(event, store, options);
  }

  if (event.type === "runtime-input") {
    return {
      ...event,
      input: await stageUserInputAttachments(event.input, store, options),
    } satisfies RuntimeInput;
  }

  return structuredClone(event);
}

export async function stageAgentEventsAttachments(
  events: readonly AgentEvent[],
  store: HostAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions = {}
): Promise<AgentEvent[]> {
  const staged: AgentEvent[] = [];
  for (const event of events) {
    staged.push(await stageAgentEventAttachments(event, store, options));
  }
  return staged;
}

function runtimeAttachmentRefs(
  value: AgentEvent | UserInput
): RuntimeAttachmentReference[] {
  if ("type" in value && value.type === "runtime-input") {
    return runtimeAttachmentRefsForUserInput(value.input);
  }

  if ("type" in value && value.type === "user-input") {
    return runtimeAttachmentRefsForUserInput(value);
  }

  return [];
}

function runtimeAttachmentRefsForUserInput(
  input: UserInput
): RuntimeAttachmentReference[] {
  if (!("content" in input)) {
    return [];
  }

  const refs: RuntimeAttachmentReference[] = [];
  for (const part of input.content) {
    if (part.type === "file") {
      const ref = runtimeAttachmentDataRef(part.data);
      if (ref) {
        refs.push(decodeRuntimeAttachmentData(ref));
      }
    }
  }
  return refs;
}

function runtimeAttachmentRefKey(ref: RuntimeAttachmentReference): string {
  return `${ref.schemaVersion}:${ref.source ?? ""}:${ref.id}`;
}
