import type { ThreadInspection } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import {
  deliverTuiInspect,
  formatThreadInspection,
  isTuiInspectCommand,
  parseTuiInspectKey,
} from "./tui-inspect";

describe("TUI inspect command", () => {
  it("recognizes the inspect command with and without an argument", () => {
    expect(isTuiInspectCommand("/inspect")).toBe(true);
    expect(isTuiInspectCommand("/inspect telegram:123")).toBe(true);
    expect(isTuiInspectCommand("/inspector")).toBe(false);
    expect(isTuiInspectCommand("hello")).toBe(false);
  });

  it("parses the requested key or leaves it undefined", () => {
    expect(parseTuiInspectKey("/inspect telegram:123")).toBe("telegram:123");
    expect(parseTuiInspectKey("/inspect   tui:local  ")).toBe("tui:local");
    expect(parseTuiInspectKey("/inspect")).toBeUndefined();
    expect(parseTuiInspectKey("hello")).toBeUndefined();
  });

  it("formats an existing session inspection with compactions", () => {
    expect(
      formatThreadInspection({
        compactionCount: 1,
        compactions: [{ endSeqExclusive: 4, startSeq: 0, summaryBytes: 12 }],
        exists: true,
        messageCount: 6,
        summaryBytes: 12,
        threadKey: "telegram:123",
        version: "7",
      })
    ).toEqual([
      "inspect telegram:123:",
      "  version: 7",
      "  messages: 6",
      "  compactions: 1",
      "  summary bytes: 12",
      "  compaction [0, 4) 12B",
    ]);
  });

  it("reports a missing session", () => {
    expect(
      formatThreadInspection({
        compactionCount: 0,
        compactions: [],
        exists: false,
        messageCount: 0,
        summaryBytes: 0,
        threadKey: "telegram:999",
        version: null,
      })
    ).toEqual(["inspect telegram:999: no stored session"]);
  });

  it("inspects another session by key and prints the report", async () => {
    const lines: string[] = [];
    const inspection: ThreadInspection = {
      compactionCount: 0,
      compactions: [],
      exists: true,
      messageCount: 2,
      summaryBytes: 0,
      threadKey: "telegram:123",
      version: "1",
    };

    await deliverTuiInspect({
      defaultKey: "tui:local",
      inspect: (key) => Promise.resolve({ ...inspection, threadKey: key }),
      output: { writeLine: (line) => lines.push(line) },
      text: "/inspect telegram:123",
    });

    expect(lines[0]).toBe("inspect telegram:123:");
  });

  it("falls back to the default key when none is provided", async () => {
    const requestedKeys: string[] = [];

    await deliverTuiInspect({
      defaultKey: "tui:local",
      inspect: (key) => {
        requestedKeys.push(key);
        return Promise.resolve({
          compactionCount: 0,
          compactions: [],
          exists: false,
          messageCount: 0,
          summaryBytes: 0,
          threadKey: key,
          version: null,
        });
      },
      output: { writeLine: () => undefined },
      text: "/inspect",
    });

    expect(requestedKeys).toEqual(["tui:local"]);
  });
});
