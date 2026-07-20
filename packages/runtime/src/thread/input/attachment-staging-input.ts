import {
  notifyImageOmitDiagnostics,
  prepareAttachmentBytesForStorage,
} from "./attachment-image-compress";
import { encodeRuntimeAttachmentData } from "./attachment-refs";
import {
  fileDataBytes,
  fileDataRequiresStaging,
  runtimeAttachmentDataRef,
} from "./attachment-staging-data";
import type {
  HostAttachmentStore,
  RuntimeAttachmentStagingOptions,
} from "./attachment-types";
import {
  RuntimeAttachmentImageLimitError,
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
} from "./attachment-types";
import type {
  UserInput,
  UserMessageContentPart,
  UserMessageFilePart,
  UserMessageTextPart,
} from "./input";

export async function stageUserInputAttachments(
  input: UserInput,
  store: HostAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions = {}
): Promise<UserInput> {
  if (!("content" in input)) {
    return structuredClone(input);
  }

  const content: UserMessageContentPart[] = [];
  for (const part of input.content) {
    if (part.type === "text") {
      content.push(structuredClone(part));
      continue;
    }

    content.push(await stageFilePart(part, store, options));
  }

  return {
    ...input,
    content,
  };
}

export function userInputRequiresAttachmentStaging(input: UserInput): boolean {
  if (!("content" in input)) {
    return false;
  }

  return input.content.some(
    (part) => part.type === "file" && fileDataRequiresStaging(part.data)
  );
}

export function userInputRequiresAttachmentProcessing(
  input: UserInput
): boolean {
  if (!("content" in input)) {
    return false;
  }

  return input.content.some((part) => part.type !== "text");
}

export function userInputContainsRuntimeAttachmentRefs(
  input: UserInput
): boolean {
  if (!("content" in input)) {
    return false;
  }

  return input.content.some(
    (part) =>
      part.type === "file" && runtimeAttachmentDataRef(part.data) !== undefined
  );
}

async function stageFilePart(
  part: UserMessageFilePart,
  store: HostAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions
): Promise<UserMessageContentPart> {
  const runtimeRef = runtimeAttachmentDataRef(part.data);
  if (runtimeRef !== undefined) {
    if (options.trustRuntimeAttachmentRefs === true) {
      return { ...part, data: runtimeRef };
    }
    throw new RuntimeAttachmentSecurityError(
      "External input cannot contain runtime attachment refs."
    );
  }

  const bytes = fileDataBytes(part.data);
  if (!bytes) {
    return structuredClone(part);
  }

  if (!store) {
    throw new RuntimeAttachmentStagingError(
      "File byte inputs require an attachment store."
    );
  }

  try {
    const prepared = await prepareAttachmentBytesForStorage({
      bytes,
      maxImageBytes: options.maxImageBytes,
      mediaType: part.mediaType,
      ...(options.onImagePrepare
        ? { onImagePrepare: options.onImagePrepare }
        : {}),
    });

    const ref = await store.put({
      bytes: prepared.bytes,
      filename: part.filename,
      mediaType: prepared.mediaType,
    });
    options.stagedRefs?.push(ref);
    return {
      ...part,
      // Keep part mediaType aligned with stored bytes (e.g. heic → image/jpeg).
      data: encodeRuntimeAttachmentData(ref),
      mediaType: prepared.mediaType,
    };
  } catch (error) {
    // Safety limits: omit this image, keep the rest of the turn (text + other files).
    // Hosts observe omits via the returned text notice; no hand-rolled stdout trees.
    if (error instanceof RuntimeAttachmentImageLimitError) {
      const omit = {
        filename: part.filename,
        limit: error.limit,
        mediaType: part.mediaType,
      };
      options.onImageOmit?.(omit);
      notifyImageOmitDiagnostics(omit);
      return imageLimitOmittedTextPart(part.filename, error);
    }
    throw error;
  }
}

function imageLimitOmittedTextPart(
  filename: string | undefined,
  error: RuntimeAttachmentImageLimitError
): UserMessageTextPart {
  const label = filename?.trim() || "image";
  return {
    type: "text",
    text: `[Attachment omitted: ${label} (${imageLimitReason(error.limit)})]`,
  };
}

function imageLimitReason(
  limit: RuntimeAttachmentImageLimitError["limit"]
): string {
  switch (limit) {
    case "input_bytes":
      return "file too large to process safely";
    case "decoded_pixels":
      return "resolution too high to process safely";
    case "storage_budget":
      return "storage budget invalid or too high";
    case "invalid_dimensions":
      return "invalid image dimensions";
    default: {
      const _exhaustive: never = limit;
      return _exhaustive;
    }
  }
}
