import type {
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
  RuntimeAttachmentStore,
} from "../../../thread/input/attachments";

export class MemoryAttachmentStore implements RuntimeAttachmentStore {
  readonly #attachments = new Map<string, RuntimeAttachmentBlob>();

  delete(ref: RuntimeAttachmentReference): Promise<void> {
    this.#attachments.delete(ref.id);
    return Promise.resolve();
  }

  get(ref: RuntimeAttachmentReference): Promise<RuntimeAttachmentBlob | null> {
    const attachment = this.#attachments.get(ref.id);
    return Promise.resolve(attachment ? cloneAttachment(attachment) : null);
  }

  put(input: RuntimeAttachmentPutInput): Promise<RuntimeAttachmentReference> {
    const id = crypto.randomUUID();
    const ref: RuntimeAttachmentReference = {
      id,
      schemaVersion: 1,
      sizeBytes: input.bytes.byteLength,
      source: "memory",
    };
    this.#attachments.set(id, cloneAttachment({ ...input, ref }));
    return Promise.resolve(ref);
  }
}

function cloneAttachment(
  attachment: RuntimeAttachmentBlob
): RuntimeAttachmentBlob {
  return {
    bytes: new Uint8Array(attachment.bytes),
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    ref: { ...attachment.ref },
  };
}
