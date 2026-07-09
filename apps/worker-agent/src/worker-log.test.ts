import { describe, expect, it } from "vitest";

import { attachmentLogFields } from "./worker-log";

describe("attachmentLogFields", () => {
  it("summarizes media types and approximate payload size", () => {
    // "AAAA" base64 → 3 raw bytes
    expect(
      attachmentLogFields([
        { dataBase64: "AAAA", mediaType: "image/jpeg" },
        { dataBase64: "AAAA", mediaType: "image/png" },
      ])
    ).toEqual({
      attachmentCount: 2,
      attachmentMediaTypes: ["image/jpeg", "image/png"],
      attachmentPayloadBytes: 6,
    });
  });
});
