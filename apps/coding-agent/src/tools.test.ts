import type { ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodingAgentWebToolsUnavailableError,
  createCodingAgentTools,
  resolveStartTuiTools,
  WEB_TOOLS_DISABLED_MESSAGE,
} from "./tools";

const tinyfishApiKeyPattern = /TINYFISH_API_KEY/;

const toolExecutionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "tool-call-test",
};

const searchResult = {
  engine: "DuckDuckGo",
  snippet: "Typed JavaScript at scale.",
  title: "TypeScript",
  url: "https://www.typescriptlang.org/",
};

const fetchResult = {
  content: "# Example\nReadable content.",
  length: 27,
  title: "Example",
  url: "https://example.com/",
};

function createStubClient() {
  return {
    fetch: vi.fn().mockResolvedValue([fetchResult]),
    search: vi.fn().mockResolvedValue([searchResult]),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("coding-agent web tools", () => {
  it("creates OpenSearch-backed web_search and web_fetch tools", async () => {
    const client = createStubClient();

    const tools = createCodingAgentTools({ client });
    const searchExecute = tools.web_search.execute;
    const fetchExecute = tools.web_fetch.execute;

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
    expect(typeof searchExecute).toBe("function");
    expect(typeof fetchExecute).toBe("function");
    if (
      typeof searchExecute !== "function" ||
      typeof fetchExecute !== "function"
    ) {
      throw new TypeError("Expected executable web tools.");
    }

    await expect(
      searchExecute(
        { numResults: 3, query: "typescript docs" },
        toolExecutionOptions
      )
    ).resolves.toStrictEqual([searchResult]);
    await expect(
      fetchExecute(
        { maxCharacters: 8000, urls: ["https://example.com/"] },
        toolExecutionOptions
      )
    ).resolves.toStrictEqual([fetchResult]);
    expect(client.search).toHaveBeenCalledWith("typescript docs", 3);
    expect(client.fetch).toHaveBeenCalledWith(["https://example.com/"], {
      maxCharacters: 8000,
    });
  });

  it("uses OpenSearch tools by default for the TUI and preserves overrides", () => {
    vi.stubEnv("TINYFISH_API_KEY", "test-key");

    const defaultTools = resolveStartTuiTools();
    const overrideTools = { custom_tool: defaultTools.web_search };

    expect(Object.keys(defaultTools)).toStrictEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(resolveStartTuiTools(overrideTools)).toBe(overrideTools);
  });
});

describe("web tools availability modes", () => {
  beforeEach(() => {
    vi.stubEnv("TINYFISH_API_KEY", undefined);
  });

  it("registers web tools by default when TINYFISH_API_KEY is present", () => {
    const tools = createCodingAgentTools({
      openSearchOptions: { env: { TINYFISH_API_KEY: "test-key" } },
    });

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("reads TINYFISH_API_KEY from process.env by default", () => {
    vi.stubEnv("TINYFISH_API_KEY", "test-key");

    const tools = createCodingAgentTools();

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("omits web tools in default optional mode when TINYFISH_API_KEY is missing and reports it", () => {
    const onWebToolsDisabled = vi.fn();

    const tools = createCodingAgentTools({ onWebToolsDisabled });

    expect(Object.keys(tools)).toStrictEqual([]);
    expect(onWebToolsDisabled).toHaveBeenCalledTimes(1);
    expect(onWebToolsDisabled).toHaveBeenCalledWith(WEB_TOOLS_DISABLED_MESSAGE);
    expect(WEB_TOOLS_DISABLED_MESSAGE).toBe(
      "web tools disabled: missing TINYFISH_API_KEY"
    );
  });

  it("warns by default when optional mode omits web tools", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tools = createCodingAgentTools();

    expect(Object.keys(tools)).toStrictEqual([]);
    expect(warn).toHaveBeenCalledWith(WEB_TOOLS_DISABLED_MESSAGE);
  });

  it("registers web tools in required mode when TINYFISH_API_KEY is present", () => {
    const tools = createCodingAgentTools({
      openSearchOptions: { env: { TINYFISH_API_KEY: "test-key" } },
      webToolsAvailability: "required",
    });

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("fails fast in required mode when TINYFISH_API_KEY is missing", () => {
    expect(() =>
      createCodingAgentTools({ webToolsAvailability: "required" })
    ).toThrowError(CodingAgentWebToolsUnavailableError);
    expect(() =>
      createCodingAgentTools({ webToolsAvailability: "required" })
    ).toThrowError(tinyfishApiKeyPattern);
  });

  it("never registers web tools in disabled mode, even when configured", () => {
    const onWebToolsDisabled = vi.fn();

    const tools = createCodingAgentTools({
      onWebToolsDisabled,
      openSearchOptions: { env: { TINYFISH_API_KEY: "test-key" } },
      webToolsAvailability: "disabled",
    });

    expect(Object.keys(tools)).toStrictEqual([]);
    expect(onWebToolsDisabled).not.toHaveBeenCalled();
  });

  it("treats an injected client as configured in required mode", () => {
    const tools = createCodingAgentTools({
      client: createStubClient(),
      webToolsAvailability: "required",
    });

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("omits web tools in disabled mode even with an injected client", () => {
    const tools = createCodingAgentTools({
      client: createStubClient(),
      webToolsAvailability: "disabled",
    });

    expect(Object.keys(tools)).toStrictEqual([]);
  });

  it("parses semicolon-separated TINYFISH_API_KEY pools like OpenSearch", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      Object.keys(
        createCodingAgentTools({
          openSearchOptions: {
            env: { TINYFISH_API_KEY: " ; key-a ;; key-b ; " },
          },
        })
      )
    ).toStrictEqual(["web_search", "web_fetch"]);
    expect(
      Object.keys(
        createCodingAgentTools({
          openSearchOptions: { env: { TINYFISH_API_KEY: " ; ; " } },
        })
      )
    ).toStrictEqual([]);
    expect(
      Object.keys(
        createCodingAgentTools({
          openSearchOptions: { env: { TINYFISH_API_KEY: "" } },
        })
      )
    ).toStrictEqual([]);
  });

  it("gates on the OpenSearch env override instead of process.env", () => {
    vi.stubEnv("TINYFISH_API_KEY", "process-env-key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tools = createCodingAgentTools({ openSearchOptions: { env: {} } });

    expect(Object.keys(tools)).toStrictEqual([]);
    expect(warn).toHaveBeenCalledWith(WEB_TOOLS_DISABLED_MESSAGE);
  });
});

describe("resolveStartTuiTools availability", () => {
  beforeEach(() => {
    vi.stubEnv("TINYFISH_API_KEY", undefined);
  });

  it("starts the TUI without web tools and warns when TINYFISH_API_KEY is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tools = resolveStartTuiTools();

    expect(Object.keys(tools)).toStrictEqual([]);
    expect(warn).toHaveBeenCalledWith(WEB_TOOLS_DISABLED_MESSAGE);
  });

  it("fails TUI tool resolution in required mode when TINYFISH_API_KEY is missing", () => {
    expect(() =>
      resolveStartTuiTools(undefined, { webToolsAvailability: "required" })
    ).toThrowError(CodingAgentWebToolsUnavailableError);
  });

  it("omits TUI web tools in disabled mode even when TINYFISH_API_KEY is present", () => {
    vi.stubEnv("TINYFISH_API_KEY", "test-key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const tools = resolveStartTuiTools(undefined, {
      webToolsAvailability: "disabled",
    });

    expect(Object.keys(tools)).toStrictEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns override tools unchanged regardless of availability mode", () => {
    const overrideTools = {};

    expect(
      resolveStartTuiTools(overrideTools, { webToolsAvailability: "required" })
    ).toBe(overrideTools);
  });
});
