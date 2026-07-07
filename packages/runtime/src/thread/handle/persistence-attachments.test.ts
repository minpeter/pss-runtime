import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { FileAttachmentStore, FileThreadStore } from "../../platform/file";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import { collect } from "./test-support";

describe("Agent thread persistence attachments", () => {
  it("file thread store preserves image file parts across reload", async () => {
    const input = [
      { text: "remember this image", type: "text" },
      {
        data: "data:image/png;base64,ZmFrZQ==",
        mediaType: "image/png",
        type: "file",
      },
      {
        data: { text: "inline note", type: "text" },
        filename: "note.txt",
        mediaType: "text/plain",
        type: "file",
      },
    ] as const;
    const directory = await mkdtemp(join(tmpdir(), "pss-runtime-image-store-"));
    const store = new FileThreadStore(directory);

    const first = new Agent({
      host: {
        attachmentStore: new FileAttachmentStore(directory),
        kind: "thread",
        threadStore: store,
      },
      model: createMockLanguageModelV4([mockLanguageModelV4Text("stored")]),
    });
    await collect(await first.thread("images").send(input));

    const secondModel = createMockLanguageModelV4([
      mockLanguageModelV4Text("DONE"),
    ]);
    const second = new Agent({
      host: {
        attachmentStore: new FileAttachmentStore(directory),
        kind: "thread",
        threadStore: store,
      },
      model: secondModel,
    });

    await collect(await second.thread("images").send("next"));

    expect(JSON.stringify(secondModel.doGenerateCalls[0]?.prompt)).toContain(
      "remember this image"
    );
    expect(JSON.stringify(secondModel.doGenerateCalls[0]?.prompt)).toContain(
      "next"
    );
  });
});
