import { defineErrorCatalog } from "evlog";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachmentLogFields,
  imagePrepareLogEvent,
  logError,
  sealPostEmitAiFlushes,
  summarizeImageOmits,
  summarizeImagePrepares,
} from "./worker-log";

const TREE_CHARS_PATTERN = /[├└]/u;

describe("sealPostEmitAiFlushes", () => {
  it("ignores ai-only set after emit", () => {
    const sets: Record<string, unknown>[] = [];
    const base = {
      set(data: Record<string, unknown>) {
        sets.push(data);
      },
      emit() {
        return { ok: true };
      },
      error() {
        return;
      },
    };
    const log = sealPostEmitAiFlushes(
      base as unknown as Parameters<typeof sealPostEmitAiFlushes>[0]
    );

    log.set({ ai: { model: "before" } });
    log.emit({ status: 200 });
    log.set({ ai: { model: "late-flush" } });
    log.set({ extra: "still forwarded" });

    expect(sets).toEqual([
      { ai: { model: "before" } },
      { extra: "still forwarded" },
    ]);
  });
});

describe("attachmentLogFields", () => {
  it("nests media types and approximate payload size under attachments", () => {
    // "AAAA" base64 → 3 raw bytes
    const fields = attachmentLogFields([
      { dataBase64: "AAAA", mediaType: "image/jpeg" },
      { dataBase64: "AAAA", mediaType: "image/png" },
    ]);
    expect(fields).toEqual({
      attachments: {
        count: 2,
        mediaTypes: ["image/jpeg", "image/png"],
        payloadBytes: 6,
      },
    });
    // Spread into input keeps nesting: input.attachments.count, not input.count.
    expect({ textChars: 5, ...fields }).toEqual({
      textChars: 5,
      attachments: {
        count: 2,
        mediaTypes: ["image/jpeg", "image/png"],
        payloadBytes: 6,
      },
    });
  });
});

describe("summarizeImagePrepares", () => {
  it("omits images when empty", () => {
    expect(summarizeImagePrepares([])).toEqual({});
  });

  it("nests prepare diagnostics for wide events", () => {
    expect(
      summarizeImagePrepares([
        {
          path: "passthrough_jpeg",
          inputBytes: 100,
          outputBytes: 100,
          inputMediaType: "image/jpeg",
          outputMediaType: "image/jpeg",
        },
      ])
    ).toEqual({
      images: {
        count: 1,
        prepares: [
          {
            path: "passthrough_jpeg",
            inputBytes: 100,
            outputBytes: 100,
            inputMediaType: "image/jpeg",
            outputMediaType: "image/jpeg",
          },
        ],
      },
    });
  });
});

describe("imagePrepareLogEvent", () => {
  it("builds a structured evlog payload without tree characters", () => {
    const event = imagePrepareLogEvent({
      path: "passthrough_jpeg",
      inputBytes: 66_540,
      outputBytes: 66_540,
      inputMediaType: "image/jpeg",
      outputMediaType: "image/jpeg",
      maxImageBytes: 240_000,
      message: "pss-runtime image-prepare",
    });
    expect(event).toEqual({
      message: "pss-runtime image-prepare",
      path: "passthrough_jpeg",
      inputBytes: 66_540,
      outputBytes: 66_540,
      inputMediaType: "image/jpeg",
      outputMediaType: "image/jpeg",
      maxImageBytes: 240_000,
    });
    expect(JSON.stringify(event)).not.toMatch(TREE_CHARS_PATTERN);
  });
});

describe("summarizeImageOmits", () => {
  it("nests soft-omit diagnostics for wide events", () => {
    expect(
      summarizeImageOmits([
        { limit: "input_bytes", mediaType: "image/heic", filename: "big.heic" },
      ])
    ).toEqual({
      imageOmits: {
        count: 1,
        omits: [
          {
            limit: "input_bytes",
            mediaType: "image/heic",
            filename: "big.heic",
          },
        ],
      },
    });
  });
});

describe("logError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves EvlogError catalog fields and cause", async () => {
    const { log } = await import("evlog");
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const catalog = defineErrorCatalog("test-log", {
      SAMPLE: {
        message: "sample failed",
        status: 502,
        why: "because",
        fix: "retry",
      },
    });
    logError(catalog.SAMPLE({ cause: new Error("root cause") }), {
      scope: "unit",
    });
    expect(errorSpy).toHaveBeenCalled();
    const [payload] = errorSpy.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      code: "test-log.SAMPLE",
      error: "sample failed",
      why: "because",
      fix: "retry",
      cause: "root cause",
      scope: "unit",
    });
  });
});
