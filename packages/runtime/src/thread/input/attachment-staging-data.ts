import { base64ToBytes } from "./attachment-base64";
import { isRuntimeAttachmentData } from "./attachment-refs";
import type { UserMessageFileData } from "./input";

export function fileDataBytes(
  data: UserMessageFileData
): Uint8Array | undefined {
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

export function fileDataRequiresStaging(data: UserMessageFileData): boolean {
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

export function runtimeAttachmentDataRef(
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
