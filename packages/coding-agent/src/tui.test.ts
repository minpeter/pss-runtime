import { describe, expect, it, vi } from "vitest";

const {
  agentCreateMock,
  clearActiveRunMock,
  createCodingLanguageModelMock,
  createTuiRunnerMock,
  fileSessionStoreMock,
  sessionCustomMock,
  sessionKillMock,
  tuiListeners,
} = vi.hoisted(() => ({
  agentCreateMock: vi.fn(),
  clearActiveRunMock: vi.fn(),
  createCodingLanguageModelMock: vi.fn(),
  createTuiRunnerMock: vi.fn(),
  fileSessionStoreMock: vi.fn(),
  sessionCustomMock: vi.fn(),
  sessionKillMock: vi.fn(),
  tuiListeners: [] as Array<
    (data: string) => { readonly consume?: boolean } | undefined
  >,
}));

vi.mock("@minpeter/pss-runtime", () => ({
  Agent: {
    create: agentCreateMock,
  },
}));

vi.mock("@minpeter/pss-runtime/plugins", () => ({
  sessions: {
    custom: sessionCustomMock,
  },
}));

vi.mock("@minpeter/pss-runtime/session-store/file", () => ({
  FileSessionStore: class {
    constructor(directory: string) {
      fileSessionStoreMock(directory);
    }
  },
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild(): undefined {
      return;
    }
  },
  Input: class {
    onSubmit: ((text: string) => void) | undefined;

    setValue(): undefined {
      return;
    }
  },
  ProcessTerminal: class {},
  TUI: class {
    addChild(): undefined {
      return;
    }

    addInputListener(
      listener: (data: string) => { readonly consume?: boolean } | undefined
    ): () => void {
      tuiListeners.push(listener);

      return () => undefined;
    }

    requestRender(): undefined {
      return;
    }

    setFocus(): undefined {
      return;
    }

    start(): undefined {
      return;
    }

    stop(): undefined {
      return;
    }
  },
  Text: class {},
  matchesKey: (data: string, key: string) => data === key,
}));

vi.mock("./model", () => ({
  createCodingLanguageModel: createCodingLanguageModelMock,
}));

vi.mock("./session-config", () => ({
  resolveCodingAgentSessionConfig: () => ({
    directory: "/tmp/pss-test-sessions",
    key: "test-session",
  }),
}));

vi.mock("./tui-runner", () => ({
  createTuiRunner: createTuiRunnerMock,
}));

describe("startTui", () => {
  it("creates the runtime agent without built-in tools", async () => {
    const session = {
      interrupt: vi.fn(),
      kill: sessionKillMock,
    };
    agentCreateMock.mockResolvedValue({
      session: vi.fn(() => session),
    });
    createCodingLanguageModelMock.mockReturnValue({ model: "test" });
    createTuiRunnerMock.mockReturnValue({
      clearActiveRun: clearActiveRunMock,
      submit: vi.fn(),
    });
    sessionCustomMock.mockReturnValue({ plugin: "session" });

    const { startTui } = await import("./tui");

    const done = startTui();
    await vi.waitUntil(() => tuiListeners.length === 1);
    tuiListeners[0]?.("ctrl+c");
    await done;

    expect(agentCreateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        tools: expect.anything(),
      })
    );
    expect(sessionKillMock).toHaveBeenCalledOnce();
    expect(clearActiveRunMock).toHaveBeenCalledOnce();
  });
});
