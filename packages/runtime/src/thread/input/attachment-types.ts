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
  readonly stagedRefs?: RuntimeAttachmentReference[];
  readonly trustRuntimeAttachmentRefs?: boolean;
}

export class RuntimeAttachmentStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeAttachmentStagingError";
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
