import { describe, expect, it } from "vitest";
import { assistantMessage } from "../test-fixtures";
import { decodeStoredSessionSnapshot, encodeSessionSnapshot } from "./snapshot";

describe("session snapshot", () => {
  it("encodes model continuation state as a versioned runtime snapshot", () => {
    const history = [assistantMessage("DONE")];
    const snapshot = encodeSessionSnapshot({ history });

    expect(snapshot).toEqual({
      compactions: [],
      history,
      pluginState: {},
      schemaVersion: 2,
    });
    expect(snapshot.history).not.toBe(history);
  });

  it("decodes missing sessions to empty continuation state", () => {
    expect(decodeStoredSessionSnapshot(null)).toEqual({
      compactions: [],
      history: [],
      pluginState: {},
    });
  });

  it("decodes v1 snapshots as v2 state from opaque stored state", () => {
    const history = [assistantMessage("persisted")];
    const decoded = decodeStoredSessionSnapshot({
      state: { history, schemaVersion: 1 },
      version: "1",
    });

    expect(decoded).toEqual({
      compactions: [],
      history,
      pluginState: {},
    });
    expect(decoded.history).not.toBe(history);
  });

  it("round trips plugin state and compaction overlays", () => {
    const history = [assistantMessage("persisted")];
    const compaction = {
      createdAt: "2026-06-05T00:00:00.000Z",
      endIndex: 3,
      id: "compact-1",
      startIndex: 0,
      summary: "Earlier work was summarized.",
    };
    const snapshot = encodeSessionSnapshot({
      compactions: [compaction],
      history,
      pluginState: { memory: { topic: "runtime" } },
    });
    const decoded = decodeStoredSessionSnapshot({
      state: snapshot,
      version: "1",
    });

    expect(decoded).toEqual({
      compactions: [compaction],
      history,
      pluginState: { memory: { topic: "runtime" } },
    });
  });

  it("rejects unsupported stored session state versions", () => {
    expect(() =>
      decodeStoredSessionSnapshot({
        state: { history: [], schemaVersion: 999 },
        version: "1",
      })
    ).toThrow("Unsupported stored session state");
  });
});
