import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORAGE_PAYLOAD_MAX_BYTES as PUBLIC_DEFAULT_STORAGE_PAYLOAD_MAX_BYTES,
  StoragePayloadSerializationError as PublicStoragePayloadSerializationError,
  StoragePayloadTooLargeError as PublicStoragePayloadTooLargeError,
} from "../index";
import {
  DEFAULT_STORAGE_PAYLOAD_MAX_BYTES,
  StoragePayloadSerializationError,
  StoragePayloadTooLargeError,
  serializedJsonByteLength,
  stringifyJsonPayloadWithinBudget,
} from "./payload-guard";

describe("storage payload guard", () => {
  it("returns the serialized payload when it is within budget", () => {
    const serialized = stringifyJsonPayloadWithinBudget(
      "event",
      { ok: true },
      20
    );

    expect(serialized).toBe(JSON.stringify({ ok: true }));
  });

  it("throws a typed error when the payload exceeds the byte budget", () => {
    const action = () =>
      stringifyJsonPayloadWithinBudget(
        "thread-state",
        { notes: "x".repeat(20) },
        16
      );

    expect(action).toThrow(StoragePayloadTooLargeError);

    try {
      action();
    } catch (error) {
      if (!(error instanceof StoragePayloadTooLargeError)) {
        throw error;
      }
      expect(error.byteLength).toBeGreaterThan(16);
      expect(error.maxBytes).toBe(16);
      expect(error.payloadKind).toBe("thread-state");
    }
  });

  it("throws a typed error for top-level values JSON cannot serialize", () => {
    const unserializableValues: readonly unknown[] = [undefined, () => "x"];

    for (const value of unserializableValues) {
      expect(() =>
        stringifyJsonPayloadWithinBudget("event", value, 100)
      ).toThrow(StoragePayloadSerializationError);
    }
  });

  it("measures serialized payload size in UTF-8 bytes", () => {
    const serialized = stringifyJsonPayloadWithinBudget(
      "thread-message",
      "한글",
      8
    );

    expect(serialized).toBe(JSON.stringify("한글"));
    expect(serializedJsonByteLength(serialized)).toBe(8);
    expect(() =>
      stringifyJsonPayloadWithinBudget("thread-message", "한글", 7)
    ).toThrow(StoragePayloadTooLargeError);
  });

  it("re-exports public budget errors and defaults from the Cloudflare entrypoint", () => {
    expect(PUBLIC_DEFAULT_STORAGE_PAYLOAD_MAX_BYTES).toBe(
      DEFAULT_STORAGE_PAYLOAD_MAX_BYTES
    );
    expect(PublicStoragePayloadTooLargeError).toBe(StoragePayloadTooLargeError);
    expect(PublicStoragePayloadSerializationError).toBe(
      StoragePayloadSerializationError
    );
  });
});
