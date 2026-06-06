import { describe, expect, it } from "vitest";
import { assistantMessage } from "../test-fixtures";
import { decodeStoredSessionSnapshot, encodeSessionSnapshot } from "./snapshot";

describe("session snapshot", () => {
  it("encodes model continuation state as a versioned runtime snapshot", () => {
    const history = [assistantMessage("DONE")];
    const snapshot = encodeSessionSnapshot(history);

    expect(snapshot).toEqual({
      history,
      schemaVersion: 1,
    });
    expect(snapshot.history).not.toBe(history);
  });

  it("decodes missing sessions to empty continuation state", () => {
    expect(decodeStoredSessionSnapshot(null)).toEqual([]);
  });

  it("decodes cloned v1 snapshots from opaque stored state", () => {
    const history = [assistantMessage("persisted")];
    const decoded = decodeStoredSessionSnapshot({
      state: { history, schemaVersion: 1 },
      version: "1",
    });

    expect(decoded).toEqual(history);
    expect(decoded).not.toBe(history);
  });

  it("rejects unsupported stored session state versions", () => {
    expect(() =>
      decodeStoredSessionSnapshot({
        state: { history: [], schemaVersion: 2 },
        version: "1",
      })
    ).toThrow("Unsupported stored session state");
  });
});
