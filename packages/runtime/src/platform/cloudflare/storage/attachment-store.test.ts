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

  it("deletes stored attachment records by ref", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const store = new CloudflareAttachmentStore({ storage });
    const ref = await store.put({
      bytes: new Uint8Array([3, 2, 1]),
      mediaType: "image/png",
    });

    await store.delete(ref);

    await expect(store.get(ref)).resolves.toBeNull();
  });

  it("rejects attachment refs that cannot be store-owned ids", async () => {
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const store = new CloudflareAttachmentStore({ storage });

    await expect(
      store.get({
        id: "../outside",
        schemaVersion: 1,
      })
    ).rejects.toThrow("Invalid CloudflareAttachmentStore ref id.");
  });
});
