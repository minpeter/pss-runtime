import { describe, expect, it } from "vitest";
import type {
  AgentHost,
  ThreadInputInbox,
  ThreadInputRecord,
} from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { MemoryAttachmentStore } from "../../platform/memory/storage/memory-attachment-store";
import { definePlugin } from "../../plugins/api";
import { noopRuntimeDiagnostics } from "../../plugins/diagnostics";
import { PluginRuntime } from "../../plugins/runtime";
import { solidTestPng } from "../../testing/valid-image-fixture";
import type {
  HostAttachmentStore,
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
} from "../input/attachments";
import type { UserInput } from "../input/input";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadEventDispatcher } from "../runtime/events";
import { createQueuedSendInput } from "./durable-queue";

describe("createQueuedSendInput", () => {
  it("deletes plugin-transformed attachment bytes when durable admission dedupes", async () => {
    const attachmentStore = new TrackingAttachmentStore();
    const pluginRuntime = await createPluginRuntime([
      transformTextToFileInputPlugin(),
    ]);
    const events = new ThreadEventDispatcher({
      attachmentStore,
      history: () => [],
      pluginRuntime,
      signal: () => undefined,
      threadKey: "plugin-duplicate",
    });

    const result = await createQueuedSendInput({
      attachmentStore,
      awaitBoundaries: false,
      events,
      executionHost: duplicateAdmissionHost(),
      input: "turn text",
      pendingOverlays: [],
      pendingRuntimeInputs: [],
      run: new BufferedAgentTurn(),
      threadKey: "plugin-duplicate",
    });

    expect(result.kind).toBe("handled");
    expect(attachmentStore.putCount).toBe(1);
    expect(attachmentStore.deletedRefs).toHaveLength(1);
    const ref = attachmentStore.deletedRefs[0];
    if (!ref) {
      throw new Error("expected plugin-transformed attachment ref cleanup");
    }
    await expect(attachmentStore.get(ref)).resolves.toBeNull();
  });

  it("deletes staged attachment bytes dropped by a successful plugin transform", async () => {
    const attachmentStore = new TrackingAttachmentStore();
    const pluginRuntime = await createPluginRuntime([
      transformAnyInputToTextPlugin(),
    ]);
    const events = new ThreadEventDispatcher({
      attachmentStore,
      history: () => [],
      pluginRuntime,
      signal: () => undefined,
      threadKey: "plugin-transform",
    });

    const result = await createQueuedSendInput({
      attachmentStore,
      awaitBoundaries: false,
      events,
      executionHost: undefined,
      input: [
        {
          data: solidTestPng(),
          filename: "discarded.png",
          mediaType: "image/png",
          type: "file",
        },
      ],
      pendingOverlays: [],
      pendingRuntimeInputs: [],
      run: new BufferedAgentTurn(),
      threadKey: "plugin-dropped",
    });

    expect(result.kind).toBe("queued");
    expect(attachmentStore.putCount).toBe(1);
    expect(attachmentStore.deletedRefs).toHaveLength(1);
    const ref = attachmentStore.deletedRefs[0];
    if (!ref) {
      throw new Error("expected dropped attachment ref cleanup");
    }
    await expect(attachmentStore.get(ref)).resolves.toBeNull();
  });
});

async function createPluginRuntime(
  definitions: ReturnType<typeof definePlugin>[]
) {
  return await PluginRuntime.create(definitions, {
    diagnostics: noopRuntimeDiagnostics,
    factoryTimeoutMs: 10_000,
    hookTimeoutMs: 10_000,
  });
}

function transformTextToFileInputPlugin() {
  return definePlugin((pss) => {
    pss.on("input.accept", (event) => {
      if (event.type !== "user-input") {
        return { action: "continue" };
      }

      return {
        action: "transform",
        value: {
          content: [
            {
              data: solidTestPng(),
              filename: "plugin.png",
              mediaType: "image/png",
              type: "file",
            },
          ],
          type: "user-input",
        },
      };
    });
  });
}

function transformAnyInputToTextPlugin() {
  return definePlugin((pss) => {
    pss.on("input.accept", (event) => {
      if (event.type !== "user-input") {
        return { action: "continue" };
      }

      return {
        action: "transform",
        value: {
          text: "plugin replacement",
          type: "user-input",
        },
      };
    });
  });
}

function duplicateAdmissionHost(): AgentHost {
  const base = createInMemoryHost();
  return {
    ...base,
    store: {
      ...base.store,
      inputs: duplicateAdmissionInbox(base.store.inputs),
    },
  };
}

function duplicateAdmissionInbox(base: ThreadInputInbox): ThreadInputInbox {
  return {
    ack: (record) => base.ack(record),
    admit: (input) =>
      Promise.resolve({
        duplicate: true,
        record: threadInputRecord(input.input, input.kind, input.messageId),
      }),
    claimNext: (threadKey, boundary, options) =>
      base.claimNext(threadKey, boundary, options),
    markPromoted: (record) => base.markPromoted(record),
    recoverClaims: (threadKey) => base.recoverClaims(threadKey),
    releaseClaim: (record) => base.releaseClaim(record),
  };
}

function threadInputRecord(
  input: UserInput,
  kind: ThreadInputRecord["kind"],
  messageId: string
): ThreadInputRecord {
  return {
    admittedAtMs: 1,
    admittedSeq: 1,
    input,
    kind,
    messageId,
    status: "pending",
    threadKey: "plugin-duplicate",
  };
}

class TrackingAttachmentStore implements HostAttachmentStore {
  readonly #store = new MemoryAttachmentStore();
  readonly deletedRefs: RuntimeAttachmentReference[] = [];
  #putCount = 0;

  get putCount(): number {
    return this.#putCount;
  }

  async delete(ref: RuntimeAttachmentReference): Promise<void> {
    this.deletedRefs.push(ref);
    await this.#store.delete(ref);
  }

  get(ref: RuntimeAttachmentReference): Promise<RuntimeAttachmentBlob | null> {
    return this.#store.get(ref);
  }

  async put(
    input: RuntimeAttachmentPutInput
  ): Promise<RuntimeAttachmentReference> {
    this.#putCount += 1;
    return await this.#store.put(input);
  }
}
