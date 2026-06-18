import { describe, expect, it } from "vitest";
import { assistantMessage } from "../../testing/test-fixtures";
import { decodeStoredThreadSnapshot, encodeThreadSnapshot } from "./snapshot";

describe("thread snapshot", () => {
  it("encodes model continuation state as a versioned runtime snapshot", () => {
    const history = [assistantMessage("DONE")];
    const snapshot = encodeThreadSnapshot(history);

    expect(snapshot).toEqual({
      history,
      schemaVersion: 1,
    });
    expect(snapshot.history).not.toBe(history);
  });

  it("decodes missing threads to empty continuation state", () => {
    expect(decodeStoredThreadSnapshot(null)).toEqual([]);
  });

  it("decodes cloned v1 snapshots from opaque stored state", () => {
    const history = [assistantMessage("persisted")];
    const decoded = decodeStoredThreadSnapshot({
      state: { history, schemaVersion: 1 },
      version: "1",
    });

    expect(decoded).toEqual(history);
    expect(decoded).not.toBe(history);
  });

  it("rejects unsupported stored thread state versions", () => {
    expect(() =>
      decodeStoredThreadSnapshot({
        state: { history: [], schemaVersion: 2 },
        version: "1",
      })
    ).toThrow("Unsupported stored thread state");
  });
});
