import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAttachmentStore } from "./file-attachment-store";

describe("FileAttachmentStore", () => {
  it("persists attachment bytes separately from thread JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-attachments-"));
    const store = new FileAttachmentStore(directory);

    const ref = await store.put({
      bytes: new Uint8Array([4, 5, 6]),
      filename: "photo.png",
      mediaType: "image/png",
    });

    await expect(store.get(ref)).resolves.toEqual({
      bytes: new Uint8Array([4, 5, 6]),
      filename: "photo.png",
      mediaType: "image/png",
      ref,
    });
  });

  it("rejects attachment refs that cannot be store-owned ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-attachments-"));
    const store = new FileAttachmentStore(directory);

    await expect(
      store.get({
        id: "../outside",
        schemaVersion: 1,
      })
    ).rejects.toThrow("Invalid FileAttachmentStore ref id.");
  });
});
