// biome-ignore-all lint/performance/noBarrelFile: Stable internal import surface for attachment helpers split by responsibility.

export { hydrateRuntimeAttachments } from "./attachment-hydration";
export {
  decodeRuntimeAttachmentData,
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
export {
  stageAgentEventAttachments,
  stageAgentEventsAttachments,
  stageUserInputAttachments,
  userInputContainsRuntimeAttachmentRefs,
  userInputRequiresAttachmentProcessing,
  userInputRequiresAttachmentStaging,
} from "./attachment-staging";
export {
  type RuntimeAttachmentBlob,
  RuntimeAttachmentHydrationError,
  type RuntimeAttachmentPutInput,
  type RuntimeAttachmentReference,
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
  type RuntimeAttachmentStagingOptions,
  type RuntimeAttachmentStore,
} from "./attachment-types";
