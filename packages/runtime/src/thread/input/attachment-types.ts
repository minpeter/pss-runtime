import type { ImagePrepareDiagnostics } from "./attachment-image-encode";

export interface RuntimeAttachmentReference {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly sizeBytes?: number;
  readonly source?: string;
}

export interface RuntimeAttachmentPutInput {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType: string;
}

export interface RuntimeAttachmentBlob extends RuntimeAttachmentPutInput {
  readonly ref: RuntimeAttachmentReference;
}

export interface HostAttachmentStore {
  delete(ref: RuntimeAttachmentReference): Promise<void>;
  get(ref: RuntimeAttachmentReference): Promise<RuntimeAttachmentBlob | null>;
  put(input: RuntimeAttachmentPutInput): Promise<RuntimeAttachmentReference>;
}

export interface ImageOmitDiagnostics {
  readonly filename?: string;
  readonly limit:
    | "decoded_pixels"
    | "input_bytes"
    | "invalid_dimensions"
    | "storage_budget";
  readonly mediaType: string;
}

export interface RuntimeAttachmentStagingOptions {
  /**
   * Max stored size for image byte inputs after compression.
   * Defaults to 240_000 (240KB) for all hosts.
   */
  readonly maxImageBytes?: number;
  /**
   * Per-staging callback when an image is soft-omitted for safety limits.
   * Hosts should log via their logger (e.g. evlog), not expect runtime stdout.
   */
  readonly onImageOmit?: (diagnostics: ImageOmitDiagnostics) => void;
  /**
   * Per-staging callback for image-prepare diagnostics (request-scoped).
   * Prefer this when the host owns the staging call site.
   */
  readonly onImagePrepare?: (diagnostics: ImagePrepareDiagnostics) => void;
  readonly stagedRefs?: RuntimeAttachmentReference[];
  readonly trustRuntimeAttachmentRefs?: boolean;
}

export class RuntimeAttachmentStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeAttachmentStagingError";
  }
}

/**
 * Image safety limit exceeded (input size / decoded pixels / budget).
 * Staging soft-fails these into a text notice so the rest of the user turn
 * can still proceed.
 */
export class RuntimeAttachmentImageLimitError extends RuntimeAttachmentStagingError {
  readonly limit:
    | "decoded_pixels"
    | "input_bytes"
    | "invalid_dimensions"
    | "storage_budget";

  constructor(
    message: string,
    limit:
      | "decoded_pixels"
      | "input_bytes"
      | "invalid_dimensions"
      | "storage_budget"
  ) {
    super(message);
    this.name = "RuntimeAttachmentImageLimitError";
    this.limit = limit;
  }
}

export class RuntimeAttachmentHydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeAttachmentHydrationError";
  }
}

export class RuntimeAttachmentSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeAttachmentSecurityError";
  }
}
