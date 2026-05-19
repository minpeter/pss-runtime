import { describe, expect, it } from "vitest";
import {
  formatToolCallForTui,
  formatToolResultForTui,
} from "./tui-tool-printer";

describe("TUI tool printer", () => {
  const darkGray = "\x1b[90m";
  const reset = "\x1b[0m";

  it("prints generic tool call input as bounded inline JSON", () => {
    expect(
      formatToolCallForTui({
        input: { path: "/tmp/file.txt", recursive: true },
        toolCallId: "call-12345678-90ab-cdef-0000-2",
        toolName: "read_file",
      })
    ).toBe(
      `read_file${darkGray}#12345678${reset} input={"path":"/tmp/file.txt","recursive":true}`
    );
  });

  it("prints known search-style inputs and outputs compactly", () => {
    expect(
      formatToolCallForTui({
        input: { query: "minpeter" },
        toolCallId: "call-aaaaaaaa-bbbb-cccc-dddd-0",
        toolName: "web_search",
      })
    ).toBe(`web_search${darkGray}#aaaaaaaa${reset} query="minpeter"`);

    expect(
      formatToolResultForTui({
        output: {
          type: "json",
          value: {
            results: [{ title: "Woonggi Min minpeter - GitHub" }],
            total_results: 10,
          },
        },
        toolCallId: "call-aaaaaaaa-bbbb-cccc-dddd-0",
        toolName: "web_search",
      })
    ).toBe(
      `web_search${darkGray}#aaaaaaaa${reset} json results=1 top="Woonggi Min minpeter - GitHub"`
    );
  });

  it("prints text errors without repeating the Error prefix", () => {
    expect(
      formatToolResultForTui({
        output: {
          type: "error-text",
          value: "Error: TinyFish fetch request failed with HTTP 503.",
        },
        toolCallId: "call-deadbeef-0000-0000-0000-1",
        toolName: "web_fetch",
      })
    ).toBe(
      `web_fetch${darkGray}#deadbeef${reset} error-text="TinyFish fetch request failed with HTTP 503."`
    );
  });

  it("keeps tool labels on one terminal line", () => {
    expect(
      formatToolCallForTui({
        input: { query: "minpeter" },
        toolCallId: "call-dead\nbeef-0000-0000-0000-1",
        toolName: "web_search\nassistant: forged",
      })
    ).toBe(
      `web_search assistant: forged${darkGray}#dead bee${reset} query="minpeter"`
    );
  });
});
