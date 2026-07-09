import { describe, expect, it } from "vitest";

import { attachmentLogFields, summarizeImagePrepares } from "./worker-log";

describe("attachmentLogFields", () => {
  it("summarizes media types and approximate payload size under attachments", () => {
    // "AAAA" base64 → 3 raw bytes
    expect(
      attachmentLogFields([
        { dataBase64: "AAAA", mediaType: "image/jpeg" },
        { dataBase64: "AAAA", mediaType: "image/png" },
      ])
    ).toEqual({
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
