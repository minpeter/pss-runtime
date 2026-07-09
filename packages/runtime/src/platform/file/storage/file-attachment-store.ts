import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
  HostAttachmentStore,
} from "../../../thread/input/attachments";

interface FileAttachmentMetadata {
  readonly filename?: string;
  readonly id: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

class FileAttachmentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAttachmentStoreError";
  }
}

const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FileAttachmentStore implements HostAttachmentStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = join(directory, "attachments");
  }

  async delete(ref: RuntimeAttachmentReference): Promise<void> {
    assertAttachmentId(ref.id);
    await Promise.all([
      rm(this.#blobFile(ref.id), { force: true }),
      rm(this.#metadataFile(ref.id), { force: true }),
    ]);
  }

  async get(
    ref: RuntimeAttachmentReference
  ): Promise<RuntimeAttachmentBlob | null> {
    assertAttachmentId(ref.id);
    try {
      const metadata = parseFileAttachmentMetadata(
        JSON.parse(await readFile(this.#metadataFile(ref.id), "utf8"))
      );
      if (metadata.id !== ref.id) {
        throw new FileAttachmentStoreError(
          "FileAttachmentStore metadata id does not match the requested ref."
        );
      }
      const bytes = new Uint8Array(await readFile(this.#blobFile(ref.id)));
      return {
        bytes,
        filename: metadata.filename,
        mediaType: metadata.mediaType,
        ref: fileReference(metadata),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async put(
    input: RuntimeAttachmentPutInput
  ): Promise<RuntimeAttachmentReference> {
    const metadata: FileAttachmentMetadata = {
      filename: input.filename,
      id: randomUUID(),
      mediaType: input.mediaType,
      sizeBytes: input.bytes.byteLength,
    };
    await mkdir(this.#directory, { recursive: true });
    try {
      await writeFile(this.#blobFile(metadata.id), input.bytes);
      await writeFile(
        this.#metadataFile(metadata.id),
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8"
      );
    } catch (error) {
      await Promise.allSettled([
        rm(this.#blobFile(metadata.id), { force: true }),
        rm(this.#metadataFile(metadata.id), { force: true }),
      ]);
      throw error;
    }
    return fileReference(metadata);
  }

  #blobFile(id: string): string {
    return join(this.#directory, `${id}.bin`);
  }

  #metadataFile(id: string): string {
    return join(this.#directory, `${id}.json`);
  }
}

function fileReference(
  metadata: FileAttachmentMetadata
): RuntimeAttachmentReference {
  return {
    id: metadata.id,
    schemaVersion: 1,
    sizeBytes: metadata.sizeBytes,
    source: "file",
  };
}

function parseFileAttachmentMetadata(value: unknown): FileAttachmentMetadata {
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("mediaType" in value) ||
    typeof value.mediaType !== "string" ||
    !("sizeBytes" in value) ||
    typeof value.sizeBytes !== "number"
  ) {
    throw new FileAttachmentStoreError("Invalid FileAttachmentStore metadata.");
  }

  assertAttachmentId(value.id);
  if (value.sizeBytes < 0 || !Number.isSafeInteger(value.sizeBytes)) {
    throw new FileAttachmentStoreError(
      "Invalid FileAttachmentStore attachment size."
    );
  }

  return {
    filename:
      "filename" in value && typeof value.filename === "string"
        ? value.filename
        : undefined,
    id: value.id,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
  };
}

function assertAttachmentId(id: string): void {
  if (!attachmentIdPattern.test(id)) {
    throw new FileAttachmentStoreError("Invalid FileAttachmentStore ref id.");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
