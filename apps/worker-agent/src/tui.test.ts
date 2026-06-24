import { describe, expect, it } from "vitest";

import { resolveWorkerAgentTuiConfig, WorkerAgentTuiConfigError } from "./tui";

describe("worker-agent TUI config", () => {
  it("resolves the default TUI channel and storage directory", () => {
    const config = resolveWorkerAgentTuiConfig({
      AI_API_KEY: "test-key",
      WORKER_AGENT_TUI_DIR: "/tmp/worker-agent-tui",
    });

    expect(config.channel).toEqual({ id: "local", kind: "tui" });
    expect(config).toMatchObject({
      directory: "/tmp/worker-agent-tui",
      mode: "local",
    });
  });

  it("resolves remote mode from environment without a local model key", () => {
    const config = resolveWorkerAgentTuiConfig({
      WORKER_AGENT_TUI_CHANNEL_ID: "dev-shell",
      WORKER_AGENT_TUI_ENDPOINT: "http://127.0.0.1:8792/trpc",
      WORKER_AGENT_TUI_TOKEN: " secret-token ",
    });

    expect(config).toEqual({
      channel: { id: "dev-shell", kind: "tui" },
      endpoint: "http://127.0.0.1:8792/trpc",
      mode: "remote",
      token: "secret-token",
    });
  });

  it("lets a CLI remote flag override the environment endpoint", () => {
    const config = resolveWorkerAgentTuiConfig(
      {
        WORKER_AGENT_TUI_ENDPOINT: "http://127.0.0.1:8792/trpc",
      },
      ["--remote", "https://worker.example.com/trpc"]
    );

    expect(config).toMatchObject({
      endpoint: "https://worker.example.com/trpc",
      mode: "remote",
    });
  });

  it("requires a local model key when no remote endpoint is configured", () => {
    expect(() => resolveWorkerAgentTuiConfig({})).toThrow(
      WorkerAgentTuiConfigError
    );
  });
});
