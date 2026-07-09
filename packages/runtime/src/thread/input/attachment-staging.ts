import type { AgentEvent, RuntimeInput } from "../protocol/events";
import { base64ToBytes } from "./attachment-base64";
import {
  decodeRuntimeAttachmentData,
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
import { prepareAttachmentBytesForStorage } from "./attachment-image-compress";
import type {
  RuntimeAttachmentReference,
  RuntimeAttachmentStagingOptions,
  HostAttachmentStore,
} from "./attachment-types";
import {
  RuntimeAttachmentSecurityError,
  RuntimeAttachmentStagingError,
} from "./attachment-types";
import type {
  UserInput,
  UserMessageContentPart,
  UserMessageFileData,
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

export async function cleanupStagedRuntimeAttachments(
  store: HostAttachmentStore | undefined,
  refs: readonly RuntimeAttachmentReference[]
): Promise<void> {
  if (!store || refs.length === 0) {
    return;
  }

  await Promise.allSettled([...refs].reverse().map((ref) => store.delete(ref)));
}

export async function cleanupUnreferencedStagedRuntimeAttachments(
  store: HostAttachmentStore | undefined,
  refs: readonly RuntimeAttachmentReference[],
  retained: readonly (AgentEvent | UserInput)[]
): Promise<void> {
  const retainedRefs = new Set<string>();
  for (const value of retained) {
    for (const ref of runtimeAttachmentRefs(value)) {
      retainedRefs.add(runtimeAttachmentRefKey(ref));
    }
  }

  await cleanupStagedRuntimeAttachments(
    store,
    refs.filter((ref) => !retainedRefs.has(runtimeAttachmentRefKey(ref)))
  );
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

export async function stageAgentEventAttachments(
  event: AgentEvent,
  store: HostAttachmentStore | undefined,
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
  store: HostAttachmentStore | undefined,
  options: RuntimeAttachmentStagingOptions = {}
): Promise<AgentEvent[]> {
  const staged: AgentEvent[] = [];
  for (const event of events) {
    staged.push(await stageAgentEventAttachments(event, store, options));
  }
  return staged;
}

function runtimeAttachmentRefs(
  value: AgentEvent | UserInput
): RuntimeAttachmentReference[] {
  if ("type" in value && value.type === "runtime-input") {
    return runtimeAttachmentRefsForUserInput(value.input);
  }

  if ("type" in value && value.type === "user-input") {
    return runtimeAttachmentRefsForUserInput(value);
  }

  return [];
}

function runtimeAttachmentRefsForUserInput(
  input: UserInput
): RuntimeAttachmentReference[] {
  if (!("content" in input)) {
    return [];
  }

  const refs: RuntimeAttachmentReference[] = [];
  for (const part of input.content) {
    if (part.type === "file") {
      const ref = runtimeAttachmentDataRef(part.data);
      if (ref) {
        refs.push(decodeRuntimeAttachmentData(ref));
      }
    }
  }
  return refs;
}

async function stageFileData(
  data: UserMessageFileData,
  part: { readonly filename?: string; readonly mediaType: string },
  store: HostAttachmentStore | undefined,
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

  const prepared = await prepareAttachmentBytesForStorage({
    bytes,
    maxImageBytes: options.maxImageBytes,
    mediaType: part.mediaType,
  });

  const ref = await store.put({
    bytes: prepared.bytes,
    filename: part.filename,
    mediaType: prepared.mediaType,
  });
  options.stagedRefs?.push(ref);
  return encodeRuntimeAttachmentData(ref);
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

  if (isReferenceFileData(data)) {
    return Object.values(data.reference).find(isRuntimeAttachmentData);
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

function isReferenceFileData(
  data: UserMessageFileData
): data is Extract<UserMessageFileData, { readonly type: "reference" }> {
  return typeof data === "object" && data !== null && "type" in data
    ? data.type === "reference"
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

function runtimeAttachmentRefKey(ref: RuntimeAttachmentReference): string {
  return `${ref.schemaVersion}:${ref.source ?? ""}:${ref.id}`;
}
