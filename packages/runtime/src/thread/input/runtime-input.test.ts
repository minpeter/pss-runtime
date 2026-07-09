import { describe, expect, it } from "vitest";
import { solidTestPng, solidTestPngBase64 } from "../../testing/valid-image-fixture";
import type {
  RuntimeAttachmentReference,
  HostAttachmentStore,
} from "./attachments";
import {
  addSteeringInput,
  closeRuntimeInput,
  createRuntimeInputState,
} from "./runtime-input";

describe("runtime input", () => {
  it("rejects staged steering input if the run closes before queueing", async () => {
    let resolvePutStarted: () => void = () => {
      throw new Error("put-started resolver was not initialized");
    };
    const putStarted = new Promise<void>((resolve) => {
      resolvePutStarted = resolve;
    });
    let resolvePut: (ref: RuntimeAttachmentReference) => void = (
      _ref: RuntimeAttachmentReference
    ) => {
      throw new Error("put-result resolver was not initialized");
    };
    const putResult = new Promise<RuntimeAttachmentReference>((resolve) => {
      resolvePut = resolve;
    });
    const deletedRefs: RuntimeAttachmentReference[] = [];
    const store: HostAttachmentStore = {
      delete: (ref) => {
        deletedRefs.push(ref);
        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      put: () => {
        resolvePutStarted();
        return putResult;
      },
    };
    const runtimeInput = createRuntimeInputState([]);
    const pending = addSteeringInput(
      runtimeInput,
      [
        {
          data: solidTestPng(),
          mediaType: "image/png",
          type: "file",
        },
      ],
      store
    );

    await putStarted;
    closeRuntimeInput(runtimeInput, "test close");
    const stagedRef = { id: "attachment-1", schemaVersion: 1 } as const;
    resolvePut(stagedRef);

    await expect(pending).rejects.toThrow(
      "thread.steer() cannot be used after test close"
    );
    expect(runtimeInput.queue).toEqual([]);
    expect(deletedRefs).toEqual([stagedRef]);
  });
});
