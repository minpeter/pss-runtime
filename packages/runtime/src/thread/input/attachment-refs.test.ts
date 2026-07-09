import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "./attachment-base64";
import {
  decodeRuntimeAttachmentData,
  encodeRuntimeAttachmentData,
  isRuntimeAttachmentData,
} from "./attachment-refs";
import { RuntimeAttachmentHydrationError } from "./attachment-types";

describe("runtime attachment refs", () => {
  it("round-trips a full reference through encode/decode", () => {
    const ref = {
      id: "a1b2c3d4-e5f6-4789-a012-3456789abcde",
      schemaVersion: 1 as const,
      sizeBytes: 12_345,
      source: "memory",
    };
    const encoded = encodeRuntimeAttachmentData(ref);
    expect(encoded.startsWith("pss-attachment:?v=1&p=")).toBe(true);
    expect(isRuntimeAttachmentData(encoded)).toBe(true);
    expect(decodeRuntimeAttachmentData(encoded)).toEqual(ref);
  });

  it("round-trips a minimal reference (id + schemaVersion only)", () => {
    const ref = {
      id: "min-id",
      schemaVersion: 1 as const,
    };
    expect(decodeRuntimeAttachmentData(encodeRuntimeAttachmentData(ref))).toEqual(
      ref
    );
  });

  it("isRuntimeAttachmentData only accepts the pss-attachment prefix", () => {
    expect(isRuntimeAttachmentData("pss-attachment:?v=1&p=x")).toBe(true);
    expect(isRuntimeAttachmentData("https://example.com/file.png")).toBe(false);
    expect(isRuntimeAttachmentData("iVBORw0KGgo=")).toBe(false);
    expect(isRuntimeAttachmentData(undefined)).toBe(false);
    expect(isRuntimeAttachmentData(null)).toBe(false);
    expect(isRuntimeAttachmentData({ id: "x" })).toBe(false);
    expect(isRuntimeAttachmentData(new Uint8Array([1, 2]))).toBe(false);
  });

  it("rejects non pss-attachment strings on decode", () => {
    expect(() => decodeRuntimeAttachmentData("not-a-ref")).toThrow(
      RuntimeAttachmentHydrationError
    );
    expect(() => decodeRuntimeAttachmentData("not-a-ref")).toThrow(
      /Expected runtime attachment data/
    );
  });

  it("rejects unsupported schema versions", () => {
    const payload = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ id: "x", schemaVersion: 1 })
      )
    );
    expect(() =>
      decodeRuntimeAttachmentData(`pss-attachment:?v=2&p=${payload}`)
    ).toThrow(/Unsupported runtime attachment data version/);
  });

  it("rejects missing payload parameter", () => {
    expect(() => decodeRuntimeAttachmentData("pss-attachment:?v=1")).toThrow(
      /missing a payload/
    );
  });

  it("rejects invalid JSON payload", () => {
    const payload = bytesToBase64Url(new TextEncoder().encode("{not-json"));
    expect(() =>
      decodeRuntimeAttachmentData(`pss-attachment:?v=1&p=${payload}`)
    ).toThrow();
  });

  it("rejects payload objects that are not valid references", () => {
    const cases: unknown[] = [
      null,
      "string",
      42,
      {},
      { schemaVersion: 1 },
      { id: "x", schemaVersion: 2 },
      { id: 123, schemaVersion: 1 },
      { id: "x", schemaVersion: "1" },
    ];
    for (const value of cases) {
      const payload = bytesToBase64Url(
        new TextEncoder().encode(JSON.stringify(value))
      );
      expect(() =>
        decodeRuntimeAttachmentData(`pss-attachment:?v=1&p=${payload}`)
      ).toThrow(RuntimeAttachmentHydrationError);
    }
  });

  it("ignores unknown optional fields and non-number sizeBytes", () => {
    const payload = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          id: "keep-me",
          schemaVersion: 1,
          sizeBytes: "nope",
          source: 99,
          extra: true,
        })
      )
    );
    expect(
      decodeRuntimeAttachmentData(`pss-attachment:?v=1&p=${payload}`)
    ).toEqual({
      id: "keep-me",
      schemaVersion: 1,
    });
  });
});
