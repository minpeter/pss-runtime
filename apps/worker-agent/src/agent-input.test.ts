import { describe, expect, it } from "vitest";

import {
  agentInputFromRequest,
  agentTurnIndexText,
  decodeBase64,
  InvalidAttachmentBase64Error,
} from "./agent-input";

describe("agentInputFromRequest", () => {
  it("returns plain text when there are no attachments", () => {
    expect(agentInputFromRequest({ attachments: [], text: "hello" })).toBe(
      "hello"
    );
  });

  it("builds multimodal parts for text plus images", () => {
    const input = agentInputFromRequest({
      attachments: [
        {
          dataBase64: btoa(String.fromCharCode(1, 2, 3)),
          filename: "a.png",
          mediaType: "image/png",
        },
      ],
      text: "what is this?",
    });

    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) {
      throw new Error("expected multimodal parts");
    }
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ text: "what is this?", type: "text" });
    expect(input[1]).toMatchObject({
      filename: "a.png",
      mediaType: "image/png",
      type: "file",
    });
    const filePart = input[1];
    if (filePart?.type !== "file") {
      throw new Error("expected file part");
    }
    expect(filePart.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("omits empty text when only images are present", () => {
    const input = agentInputFromRequest({
      attachments: [{ dataBase64: "AA==", mediaType: "image/jpeg" }],
      text: "",
    });
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) {
      throw new Error("expected multimodal parts");
    }
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ mediaType: "image/jpeg", type: "file" });
  });
});

describe("decodeBase64", () => {
  it("throws a typed error for invalid base64", () => {
    expect(() => decodeBase64("!!!not-base64!!!")).toThrow(
      InvalidAttachmentBase64Error
    );
  });
});

describe("agentTurnIndexText", () => {
  it("labels image-only turns for the session index", () => {
    expect(
      agentTurnIndexText({
        attachments: [{ dataBase64: "AA==", mediaType: "image/jpeg" }],
        text: "",
      })
    ).toBe("[image]");
  });

  it("appends an image label after caption text", () => {
    expect(
      agentTurnIndexText({
        attachments: [
          { dataBase64: "AA==", mediaType: "image/jpeg" },
          { dataBase64: "AQ==", mediaType: "image/png" },
        ],
        text: "caption",
      })
    ).toBe("caption\n[2 images]");
  });
});
