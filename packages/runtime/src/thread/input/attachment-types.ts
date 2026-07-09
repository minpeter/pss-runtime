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

export interface RuntimeAttachmentStagingOptions {
  /**
   * Max stored size for image byte inputs after compression.
   * Defaults to 1_000_000 (1MB) for all hosts.
   */
  readonly maxImageBytes?: number;
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
