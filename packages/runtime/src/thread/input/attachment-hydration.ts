import type { ModelMessage } from "ai";
import {
  decodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
import type { RuntimeAttachmentStore } from "./attachment-types";
import { RuntimeAttachmentHydrationError } from "./attachment-types";

export async function hydrateRuntimeAttachments(
  history: readonly ModelMessage[],
  store: RuntimeAttachmentStore | undefined
): Promise<ModelMessage[]> {
  const hydrated: ModelMessage[] = [];
  for (const message of history) {
    if (message.role !== "user" || typeof message.content === "string") {
      hydrated.push(structuredClone(message));
      continue;
    }

    const content: typeof message.content = [];
    for (const part of message.content) {
      if (part.type !== "file" || !isRuntimeAttachmentData(part.data)) {
        content.push(structuredClone(part));
        continue;
      }

      if (!store) {
        throw new RuntimeAttachmentHydrationError(
          "Runtime attachment hydration requires an attachment store."
        );
      }

      const ref = decodeRuntimeAttachmentData(part.data);
      const blob = await store.get(ref);
      if (!blob) {
        throw new RuntimeAttachmentHydrationError(
          `Runtime attachment ${JSON.stringify(ref.id)} was not found.`
        );
      }

      content.push({
        ...part,
        data: blob.bytes,
        filename: part.filename ?? blob.filename,
        mediaType: blob.mediaType,
      });
    }

    hydrated.push({ ...message, content });
  }

  return hydrated;
}
