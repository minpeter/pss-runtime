import { base64UrlToBytes, bytesToBase64Url } from "./attachment-base64";
import type { RuntimeAttachmentReference } from "./attachment-types";
import { RuntimeAttachmentHydrationError } from "./attachment-types";

const attachmentDataPrefix = "pss-attachment:";

export function encodeRuntimeAttachmentData(
  ref: RuntimeAttachmentReference
): string {
  return `${attachmentDataPrefix}?v=1&p=${base64UrlEncodeJson(ref)}`;
}

export function isRuntimeAttachmentData(data: unknown): data is string {
  return typeof data === "string" && data.startsWith(attachmentDataPrefix);
}

export function decodeRuntimeAttachmentData(
  data: string
): RuntimeAttachmentReference {
  if (!isRuntimeAttachmentData(data)) {
    throw new RuntimeAttachmentHydrationError(
      "Expected runtime attachment data."
    );
  }

  const url = new URL(data);
  if (url.searchParams.get("v") !== "1") {
    throw new RuntimeAttachmentHydrationError(
      "Unsupported runtime attachment data version."
    );
  }

  const payload = url.searchParams.get("p");
  if (!payload) {
    throw new RuntimeAttachmentHydrationError(
      "Runtime attachment data is missing a payload."
    );
  }

  return parseRuntimeAttachmentReference(base64UrlDecodeJson(payload));
}

function parseRuntimeAttachmentReference(
  value: unknown
): RuntimeAttachmentReference {
  if (
    value === null ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new RuntimeAttachmentHydrationError(
      "Invalid runtime attachment reference payload."
    );
  }

  return {
    id: value.id,
    schemaVersion: 1,
    ...("sizeBytes" in value && typeof value.sizeBytes === "number"
      ? { sizeBytes: value.sizeBytes }
      : {}),
    ...("source" in value && typeof value.source === "string"
      ? { source: value.source }
      : {}),
  };
}

function base64UrlEncodeJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlDecodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}
