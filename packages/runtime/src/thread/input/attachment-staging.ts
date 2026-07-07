import type { AgentEvent, RuntimeInput } from "../protocol/events";
import { base64ToBytes } from "./attachment-base64";
import {
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
import type {
  RuntimeAttachmentStagingOptions,
  RuntimeAttachmentStore,
} from "./attachment-types";
import {
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
} from "./attachment-types";
import type {
  UserInput,
  UserMessageContentPart,
  UserMessageFileData,
  UserMessageFilePart,
} from "./input";

export async function stageUserInputAttachments(
  input: UserInput,
  store: RuntimeAttachmentStore | undefined,
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

    if (part.type === "image") {
      content.push(await stageImagePart(part, store, options));
      continue;
    }

    content.push({
      ...part,
      data: await stageFileData(part.data, part, store, options),
    });
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

  return input.content.some((part) => {
    if (part.type === "file") {
      return fileDataRequiresStaging(part.data);
    }

    return part.type === "image" && !isRemoteUrl(part.image);
  });
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

  return input.content.some((part) => {
    if (part.type === "image") {
      return isRuntimeAttachmentData(part.image);
    }

    return (
      part.type === "file" && runtimeAttachmentDataRef(part.data) !== undefined
    );
  });
}

export async function stageAgentEventAttachments(
  event: AgentEvent,
  store: RuntimeAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions = {}
): Promise<AgentEvent> {
  if (event.type === "user-input") {
    return stageUserInputAttachments(event, store, options);
  }

  if (event.type === "runtime-input") {
    return {
      ...event,
      input: await stageUserInputAttachments(event.input, store, options),
    } satisfies RuntimeInput;
  }

  return structuredClone(event);
}

export async function stageAgentEventsAttachments(
  events: readonly AgentEvent[],
  store: RuntimeAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions = {}
): Promise<AgentEvent[]> {
  const staged: AgentEvent[] = [];
  for (const event of events) {
    staged.push(await stageAgentEventAttachments(event, store, options));
  }
  return staged;
}

async function stageFileData(
  data: UserMessageFileData,
  part: { readonly filename?: string; readonly mediaType: string },
  store: RuntimeAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions
): Promise<UserMessageFileData> {
  const runtimeRef = runtimeAttachmentDataRef(data);
  if (runtimeRef !== undefined) {
    if (options.trustRuntimeAttachmentRefs === true) {
      return runtimeRef;
    }
    throw new RuntimeAttachmentSecurityError(
      "External input cannot contain runtime attachment refs."
    );
  }

  const bytes = fileDataBytes(data);
  if (!bytes) {
    return structuredClone(data);
  }

  if (!store) {
    throw new RuntimeAttachmentStagingError(
      "File byte inputs require an attachment store."
    );
  }

  const ref = await store.put({
    bytes,
    filename: part.filename,
    mediaType: part.mediaType,
  });
  return encodeRuntimeAttachmentData(ref);
}

async function stageImagePart(
  part: {
    readonly image: string;
    readonly mediaType?: string;
    readonly type: "image";
  },
  store: RuntimeAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions
): Promise<UserMessageFilePart> {
  if (isRuntimeAttachmentData(part.image)) {
    if (options.trustRuntimeAttachmentRefs === true) {
      return {
        data: part.image,
        mediaType: part.mediaType ?? "image",
        type: "file",
      };
    }
    throw new RuntimeAttachmentSecurityError(
      "External input cannot contain runtime attachment refs."
    );
  }

  const mediaType = part.mediaType ?? "image";
  if (isRemoteUrl(part.image)) {
    return {
      data: part.image,
      mediaType,
      type: "file",
    };
  }

  return {
    data: await stageFileData(
      { data: part.image, type: "data" },
      { mediaType },
      store,
      options
    ),
    mediaType,
    type: "file",
  };
}

function fileDataBytes(data: UserMessageFileData): Uint8Array | undefined {
  if (typeof data === "string") {
    return isRemoteUrl(data) ? undefined : base64DataToBytes(data);
  }

  if (isBytes(data)) {
    return bytesFromBinary(data);
  }

  if (isDataFileData(data)) {
    return typeof data.data === "string"
      ? base64DataToBytes(data.data)
      : bytesFromBinary(data.data);
  }

  return;
}

function fileDataRequiresStaging(data: UserMessageFileData): boolean {
  if (isRuntimeAttachmentData(data)) {
    return false;
  }
  if (typeof data === "string") {
    return !isRemoteUrl(data);
  }
  if (isBytes(data)) {
    return true;
  }
  if (isDataFileData(data)) {
    return true;
  }
  return false;
}

function runtimeAttachmentDataRef(
  data: UserMessageFileData
): string | undefined {
  if (isRuntimeAttachmentData(data)) {
    return data;
  }

  if (
    isDataFileData(data) &&
    typeof data.data === "string" &&
    isRuntimeAttachmentData(data.data)
  ) {
    return data.data;
  }

  if (isUrlFileData(data) && isRuntimeAttachmentData(data.url)) {
    return data.url;
  }

  return;
}

function isDataFileData(
  data: UserMessageFileData
): data is Extract<UserMessageFileData, { readonly type: "data" }> {
  return typeof data === "object" && data !== null && "type" in data
    ? data.type === "data"
    : false;
}

function isUrlFileData(
  data: UserMessageFileData
): data is Extract<UserMessageFileData, { readonly type: "url" }> {
  return typeof data === "object" && data !== null && "type" in data
    ? data.type === "url"
    : false;
}

function isBytes(data: unknown): data is ArrayBuffer | Uint8Array {
  return data instanceof ArrayBuffer || data instanceof Uint8Array;
}

function bytesFromBinary(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function base64DataToBytes(data: string): Uint8Array {
  const payload = data.startsWith("data:")
    ? (data.split(",", 2)[1] ?? "")
    : data;
  return base64ToBytes(payload);
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
