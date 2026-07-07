import type {
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
  RuntimeAttachmentStore,
} from "../../../thread/input/attachments";
import type { CloudflareDurableObjectTransactionStorage } from "./durable-object/durable-object-storage";

interface StoredCloudflareAttachment {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly id: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export class CloudflareAttachmentStore implements RuntimeAttachmentStore {
  readonly #prefix: string;
  readonly #storage: CloudflareDurableObjectTransactionStorage;

  constructor({
    prefix = "pss-runtime",
    storage,
  }: {
    readonly prefix?: string;
    readonly storage: CloudflareDurableObjectTransactionStorage;
  }) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async get(
    ref: RuntimeAttachmentReference
  ): Promise<RuntimeAttachmentBlob | null> {
    const stored = await this.#storage.get<StoredCloudflareAttachment>(
      this.#key(ref.id)
    );
    if (!stored) {
      return null;
    }

    return {
      bytes: new Uint8Array(stored.bytes),
      filename: stored.filename,
      mediaType: stored.mediaType,
      ref: cloudflareReference(stored),
    };
  }

  async put(
    input: RuntimeAttachmentPutInput
  ): Promise<RuntimeAttachmentReference> {
    const stored: StoredCloudflareAttachment = {
      bytes: new Uint8Array(input.bytes),
      filename: input.filename,
      id: crypto.randomUUID(),
      mediaType: input.mediaType,
      sizeBytes: input.bytes.byteLength,
    };
    await this.#storage.put(this.#key(stored.id), stored);
    return cloudflareReference(stored);
  }

  #key(id: string): string {
    return `${this.#prefix}:attachment:${id}`;
  }
}

function cloudflareReference(
  stored: StoredCloudflareAttachment
): RuntimeAttachmentReference {
  return {
    id: stored.id,
    schemaVersion: 1,
    sizeBytes: stored.sizeBytes,
    source: "cloudflare",
  };
}
