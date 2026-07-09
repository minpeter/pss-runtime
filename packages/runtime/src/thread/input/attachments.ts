// biome-ignore-all lint/performance/noBarrelFile: Stable internal import surface for attachment helpers split by responsibility.

export { hydrateRuntimeAttachments } from "./attachment-hydration";
export {
  getInstalledImageCodecWasm,
  installImageCodecWasm,
  installImageCodecWasmFromNodeModules,
  type ImageCodecWasmModules,
} from "./attachment-image-codec-registry";
export {
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  isCompressibleImageMediaType,
  isStoredImageMediaType,
  prepareAttachmentBytesForStorage,
  type PreparedAttachmentBytes,
  STORED_IMAGE_MEDIA_TYPES,
  type StoredImageMediaType,
} from "./attachment-image-compress";
export {
  decodeRuntimeAttachmentData,
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
export {
  cleanupStagedRuntimeAttachments,
  cleanupUnreferencedStagedRuntimeAttachments,
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
  type HostAttachmentStore,
} from "./attachment-types";
