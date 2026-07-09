/**
 * Focused pipeline coverage: normalize → stage → store → hydrate → model step.
 * Not a full app/Telegram E2E; connects the layers that unit tests leave separate.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAttachmentStore } from "../../platform/memory";
import {
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  loadModelStepRunner,
  collectRun,
} from "../../testing/llm-test-utils";
import { hostWithThreads } from "../../testing/host-with-threads";
import { assistantMessage } from "../../testing/test-fixtures";
import { SpyStore } from "../handle/test-support";
import { hydrateRuntimeAttachments } from "./attachment-hydration";
import {
  decodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
import { isStoredImageMediaType } from "./attachment-image-compress";
import { stageUserInputAttachments } from "./attachment-staging";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const generateTextMock = getGenerateTextMock();

describe("attachment pipeline", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  it(
    "stages HEIC to jpeg ref, then hydrates jpeg bytes for the model",
    async () => {
      const store = new MemoryAttachmentStore();
      const heic = new Uint8Array(
        readFileSync(join(fixturesDir, "sample.heic"))
      );

      const staged = await stageUserInputAttachments(
        {
          type: "user-input",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "file",
              mediaType: "image/heic",
              filename: "photo.heic",
              data: heic,
            },
          ],
        },
        store
      );

      if (!("content" in staged)) {
        throw new Error("expected multipart user input");
      }
      const filePart = staged.content[1];
      if (filePart?.type !== "file" || typeof filePart.data !== "string") {
        throw new Error("expected staged file ref string");
      }
      expect(isRuntimeAttachmentData(filePart.data)).toBe(true);
      // History keeps the staged mediaType from prepare (jpeg after normalize).
      expect(filePart.mediaType).toBe("image/jpeg");

      const ref = decodeRuntimeAttachmentData(filePart.data);
      const blob = await store.get(ref);
      expect(blob).not.toBeNull();
      expect(blob?.mediaType).toBe("image/jpeg");
      expect(isStoredImageMediaType(blob?.mediaType ?? "")).toBe(true);
      expect(blob?.bytes[0]).toBe(0xff);
      expect(blob?.bytes[1]).toBe(0xd8);

      const history = [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "what is this?" },
            {
              type: "file" as const,
              data: filePart.data,
              mediaType: filePart.mediaType,
              filename: filePart.filename,
            },
          ],
        },
      ];

      const hydrated = await hydrateRuntimeAttachments(history, store);
      const hydratedFile = hydrated[0]?.content;
      if (!Array.isArray(hydratedFile)) {
        throw new Error("expected multipart hydrated content");
      }
      const modelFile = hydratedFile.find((p) => p.type === "file");
      if (!modelFile || modelFile.type !== "file") {
        throw new Error("expected hydrated file part");
      }
      expect(modelFile.mediaType).toBe("image/jpeg");
      expect(modelFile.data).toBeInstanceOf(Uint8Array);
      const modelBytes = modelFile.data as Uint8Array;
      expect(modelBytes[0]).toBe(0xff);
      expect(modelBytes[1]).toBe(0xd8);
      // History ref string must not be mutated by hydrate.
      expect(history[0]?.content[1]).toMatchObject({
        data: filePart.data,
        type: "file",
      });

      const runModelStep = await loadModelStepRunner();
      await runModelStep(
        { attachmentStore: store, model: fakeModel },
        { history, signal: new AbortController().signal }
      );
      const messages = generateTextMock.mock.calls.at(-1)?.[0].messages;
      const sent = messages?.[0]?.content?.find(
        (p: { type: string }) => p.type === "file"
      );
      expect(sent?.mediaType).toBe("image/jpeg");
      expect(sent?.data).toBeInstanceOf(Uint8Array);
      expect(sent?.data[0]).toBe(0xff);
      expect(sent?.data[1]).toBe(0xd8);
    },
    45_000
  );

  it(
    "Agent.send HEIC: commits pss-attachment ref and sends jpeg bytes to the model",
    async () => {
      const threadStore = new SpyStore();
      const attachmentStore = new MemoryAttachmentStore();
      const heic = new Uint8Array(
        readFileSync(join(fixturesDir, "sample.heic"))
      );
      const Agent = await loadAgent();
      const agent = new Agent({
        attachmentStore,
        host: hostWithThreads(threadStore, attachmentStore),
        model: fakeModel,
      });

      const events = await collectRun(
        await agent.send([
          { text: "describe", type: "text" },
          {
            data: heic,
            filename: "photo.heic",
            mediaType: "image/heic",
            type: "file",
          },
        ])
      );
      expect(events.filter((e) => e.type === "turn-error")).toEqual([]);

      const accepted = events[0];
      if (accepted?.type !== "user-input" || !("content" in accepted)) {
        throw new Error("expected staged user-input");
      }
      const part = accepted.content.find((p) => p.type === "file");
      if (!part || part.type !== "file" || typeof part.data !== "string") {
        throw new Error("expected file ref on accepted input");
      }
      expect(isRuntimeAttachmentData(part.data)).toBe(true);
      expect(part.mediaType).toBe("image/jpeg");

      const committedJson = JSON.stringify(threadStore.commits.at(0)?.next.state);
      expect(committedJson).toContain("pss-attachment:");
      // Original HEIC media type should not linger as stored media type for the part.
      expect(committedJson).not.toContain("image/heic");

      const blob = await attachmentStore.get(
        decodeRuntimeAttachmentData(part.data)
      );
      expect(blob?.mediaType).toBe("image/jpeg");
      expect(blob?.bytes[0]).toBe(0xff);

      const generateTextInput = generateTextMock.mock.calls.at(-1)?.[0];
      const modelFile = generateTextInput?.messages?.[0]?.content?.find(
        (p: { type: string }) => p.type === "file"
      );
      expect(modelFile?.mediaType).toBe("image/jpeg");
      expect(modelFile?.data).toBeInstanceOf(Uint8Array);
      expect(modelFile?.data[0]).toBe(0xff);
      expect(modelFile?.data[1]).toBe(0xd8);
    },
    45_000
  );
});
