import { describe, expect, it } from "vitest";

import {
  attachmentLogFields,
  imagePrepareLogEvent,
  summarizeImagePrepares,
} from "./worker-log";

const TREE_CHARS_PATTERN = /[├└]/u;

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
      maxImageBytes: 1_000_000,
      message: "pss-runtime image-prepare",
    });
    expect(event).toEqual({
      message: "pss-runtime image-prepare",
      path: "passthrough_jpeg",
      inputBytes: 66_540,
      outputBytes: 66_540,
      inputMediaType: "image/jpeg",
      outputMediaType: "image/jpeg",
      maxImageBytes: 1_000_000,
    });
    expect(JSON.stringify(event)).not.toMatch(TREE_CHARS_PATTERN);
  });
});
