import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "../../platform/memory";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
} from "../../testing/llm-test-utils";
import { assistantMessage } from "../../testing/test-fixtures";
import { SpyStore } from "../handle/test-support";
import {
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "../input/attachments";

const generateTextMock = getGenerateTextMock();

describe("runtime attachment staging", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  it("stores file bytes as an internal ref before committing user history", async () => {
    const threadStore = new SpyStore();
    const attachmentStore = new MemoryAttachmentStore();
    const imageBytes = new Uint8Array([11, 22, 33, 44]);
    const Agent = await loadAgent();
    const agent = new Agent({
      attachmentStore,
      host: { attachmentStore, kind: "thread", threadStore },
      model: fakeModel,
    });

    const events = await collectRun(
      await agent.send([
        { text: "describe", type: "text" },
        {
          data: imageBytes,
          filename: "photo.png",
          mediaType: "image/png",
          type: "file",
        },
      ])
    );
    expect(events.filter((event) => event.type === "turn-error")).toEqual([]);
    const acceptedInput = events[0];
    if (acceptedInput?.type !== "user-input" || !("content" in acceptedInput)) {
      throw new Error("expected staged multipart user-input event");
    }
    const acceptedFilePart = acceptedInput.content[1];
    expect(acceptedFilePart?.type).toBe("file");
    if (acceptedFilePart?.type !== "file") {
      throw new Error("expected staged event file part");
    }
    expect(isRuntimeAttachmentData(acceptedFilePart.data)).toBe(true);

    const committedState = threadStore.commits.at(0)?.next.state;
    const committedJson = JSON.stringify(committedState);
    expect(committedJson).toContain("pss-attachment:");
    expect(committedJson).not.toContain('"0":11');
    expect(committedJson).not.toContain('"1":22');

    const committedPart = filePartFromStoredState(committedState);
    expect(isRuntimeAttachmentData(committedPart.data)).toBe(true);

    const generateTextInput = generateTextMock.mock.calls.at(-1)?.[0];
    expect(generateTextInput?.messages).toEqual([
      {
        content: [
          { text: "describe", type: "text" },
          {
            data: imageBytes,
            filename: "photo.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);
  });

  it("stores base64 file strings as an internal ref before committing user history", async () => {
    const threadStore = new SpyStore();
    const attachmentStore = new MemoryAttachmentStore();
    const Agent = await loadAgent();
    const agent = new Agent({
      attachmentStore,
      host: { attachmentStore, kind: "thread", threadStore },
      model: fakeModel,
    });

    const events = await collectRun(
      await agent.send([
        { text: "describe", type: "text" },
        {
          data: "AQIDBA==",
          filename: "photo.png",
          mediaType: "image/png",
          type: "file",
        },
      ])
    );
    const acceptedInput = events[0];
    if (acceptedInput?.type !== "user-input" || !("content" in acceptedInput)) {
      throw new Error("expected staged multipart user-input event");
    }
    const acceptedFilePart = acceptedInput.content[1];
    expect(acceptedFilePart?.type).toBe("file");
    if (acceptedFilePart?.type !== "file") {
      throw new Error("expected staged event file part");
    }
    expect(isRuntimeAttachmentData(acceptedFilePart.data)).toBe(true);

    const committedPart = filePartFromStoredState(
      threadStore.commits.at(0)?.next.state
    );
    expect(isRuntimeAttachmentData(committedPart.data)).toBe(true);

    const generateTextInput = generateTextMock.mock.calls.at(-1)?.[0];
    expect(generateTextInput?.messages).toEqual([
      {
        content: [
          { text: "describe", type: "text" },
          {
            data: new Uint8Array([1, 2, 3, 4]),
            filename: "photo.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);
  });

  it("rejects externally supplied runtime attachment refs before queueing", async () => {
    const threadStore = new SpyStore();
    const attachmentStore = new MemoryAttachmentStore();
    const Agent = await loadAgent();
    const agent = new Agent({
      attachmentStore,
      host: { attachmentStore, kind: "thread", threadStore },
      model: fakeModel,
    });

    await expect(
      agent.send([
        { text: "spoof", type: "text" },
        {
          data: encodeRuntimeAttachmentData({
            id: "attacker-controlled",
            schemaVersion: 1,
          }),
          mediaType: "image/png",
          type: "file",
        },
      ])
    ).rejects.toThrow("External input cannot contain runtime attachment refs.");
    expect(threadStore.commits).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("rejects nested externally supplied runtime attachment refs before queueing", async () => {
    const threadStore = new SpyStore();
    const attachmentStore = new MemoryAttachmentStore();
    const Agent = await loadAgent();
    const agent = new Agent({
      attachmentStore,
      host: { attachmentStore, kind: "thread", threadStore },
      model: fakeModel,
    });

    await expect(
      agent.send([
        { text: "spoof", type: "text" },
        {
          data: {
            data: encodeRuntimeAttachmentData({
              id: "attacker-controlled",
              schemaVersion: 1,
            }),
            type: "data",
          },
          mediaType: "image/png",
          type: "file",
        },
      ])
    ).rejects.toThrow("External input cannot contain runtime attachment refs.");
    expect(threadStore.commits).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("rejects url-wrapped externally supplied runtime attachment refs before queueing", async () => {
    const threadStore = new SpyStore();
    const attachmentStore = new MemoryAttachmentStore();
    const Agent = await loadAgent();
    const agent = new Agent({
      attachmentStore,
      host: { attachmentStore, kind: "thread", threadStore },
      model: fakeModel,
    });

    await expect(
      agent.send([
        { text: "spoof", type: "text" },
        {
          data: {
            type: "url",
            url: encodeRuntimeAttachmentData({
              id: "attacker-controlled",
              schemaVersion: 1,
            }),
          },
          mediaType: "image/png",
          type: "file",
        },
      ])
    ).rejects.toThrow("External input cannot contain runtime attachment refs.");
    expect(threadStore.commits).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("rejects file bytes before queueing when a custom host has no attachment store", async () => {
    const threadStore = new SpyStore();
    const Agent = await loadAgent();
    const agent = new Agent({
      host: { kind: "thread", threadStore },
      model: fakeModel,
    });

    await expect(
      agent.send([
        { text: "describe", type: "text" },
        {
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
          type: "file",
        },
      ])
    ).rejects.toThrow("File byte inputs require an attachment store.");
    expect(threadStore.commits).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

function filePartFromStoredState(state: unknown): {
  readonly data: unknown;
  readonly type: "file";
} {
  if (
    state === null ||
    typeof state !== "object" ||
    !("history" in state) ||
    !Array.isArray(state.history)
  ) {
    throw new Error("expected stored thread state with history");
  }

  const history: readonly unknown[] = state.history;
  const [message] = history;
  if (
    message === null ||
    typeof message !== "object" ||
    !("content" in message) ||
    !Array.isArray(message.content)
  ) {
    throw new Error("expected stored user message content");
  }

  const content: readonly unknown[] = message.content;
  const part = content.find(isStoredFilePart);
  if (part === undefined) {
    throw new Error("expected stored file part");
  }

  return part;
}

function isStoredFilePart(
  value: unknown
): value is { readonly data: unknown; readonly type: "file" } {
  return (
    value !== null &&
    typeof value === "object" &&
    "data" in value &&
    "type" in value &&
    value.type === "file"
  );
}
