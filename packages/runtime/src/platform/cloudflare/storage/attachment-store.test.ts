import { describe, expect, it } from "vitest";
import { CloudflareAttachmentStore } from "./attachment-store";
import { InMemoryCloudflareDurableObjectStorage } from "./durable-object/durable-object-storage";

describe("CloudflareAttachmentStore", () => {
  it("stores attachment bytes outside SQLite thread rows", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const store = new CloudflareAttachmentStore({ storage });

    const ref = await store.put({
      bytes: new Uint8Array([3, 2, 1]),
      filename: "photo.png",
      mediaType: "image/png",
    });

    await expect(store.get(ref)).resolves.toEqual({
      bytes: new Uint8Array([3, 2, 1]),
      filename: "photo.png",
      mediaType: "image/png",
      ref,
    });
  });
});
