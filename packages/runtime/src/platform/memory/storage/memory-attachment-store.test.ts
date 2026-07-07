import { describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "./memory-attachment-store";

describe("MemoryAttachmentStore", () => {
  it("round-trips attachment bytes and metadata by ref", async () => {
    const store = new MemoryAttachmentStore();
    const bytes = new Uint8Array([9, 8, 7]);

    const ref = await store.put({
      bytes,
      filename: "photo.png",
      mediaType: "image/png",
    });
    bytes[0] = 1;

    await expect(store.get(ref)).resolves.toEqual({
      bytes: new Uint8Array([9, 8, 7]),
      filename: "photo.png",
      mediaType: "image/png",
      ref,
    });
  });

  it("deletes stored attachments by ref", async () => {
    const store = new MemoryAttachmentStore();
    const ref = await store.put({
      bytes: new Uint8Array([9, 8, 7]),
      mediaType: "image/png",
    });

    await store.delete(ref);

    await expect(store.get(ref)).resolves.toBeNull();
  });
});
