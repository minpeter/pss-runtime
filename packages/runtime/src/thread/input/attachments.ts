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
  type ImagePrepareDiagnostics,
  type ImagePrepareDiagnosticsListener,
  type ImagePreparePath,
  isCompressibleImageMediaType,
  isStoredImageMediaType,
  MAX_IMAGE_DECODED_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_STORAGE_BUDGET_BYTES,
  type PreparedAttachmentBytes,
  prepareAttachmentBytesForStorage,
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
  type HostAttachmentStore,
  type ImageOmitDiagnostics,
  type RuntimeAttachmentBlob,
  RuntimeAttachmentHydrationError,
  RuntimeAttachmentImageLimitError,
  type RuntimeAttachmentPutInput,
  type RuntimeAttachmentReference,
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
  type RuntimeAttachmentStagingOptions,
} from "./attachment-types";
