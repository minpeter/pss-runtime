import { describe, expect, it } from "vitest";
import { resolveCodingAgentThreadConfig } from "./thread-config";

describe("resolveCodingAgentThreadConfig", () => {
  it("defaults to a durable home directory and cwd-scoped key", () => {
    expect(
      resolveCodingAgentThreadConfig({}, "/repo/demo", "/home/me")
    ).toEqual({
      autoCompaction: false,
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });

  it("allows callers to override the file directory and thread key", () => {
    expect(
      resolveCodingAgentThreadConfig(
        {
          PSS_THREAD_DIR: ".pss/threads",
          PSS_THREAD_KEY: "workspace:demo",
        },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: false,
      directory: ".pss/threads",
      key: "workspace:demo",
    });
  });

  it("accepts legacy session env overrides", () => {
    expect(
      resolveCodingAgentThreadConfig(
        {
          PSS_SESSION_DIR: ".pss/sessions",
          PSS_SESSION_KEY: "workspace:legacy",
        },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: false,
      directory: ".pss/sessions",
      key: "workspace:legacy",
    });
  });

  it("treats blank env overrides as absent", () => {
    expect(
      resolveCodingAgentThreadConfig(
        { PSS_THREAD_DIR: " ", PSS_THREAD_KEY: "" },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: false,
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });

  it("enables auto compaction from explicit positive integer env values", () => {
    expect(
      resolveCodingAgentThreadConfig(
        {
          PSS_AUTO_COMPACTION_MIN_MESSAGES: "12",
          PSS_AUTO_COMPACTION_RETAIN_MESSAGES: "4",
        },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      autoCompaction: { minMessages: 12, retainMessages: 4 },
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });

  it.each([
    {
      env: { PSS_AUTO_COMPACTION_MIN_MESSAGES: "12" },
      message:
        "PSS_AUTO_COMPACTION_MIN_MESSAGES and PSS_AUTO_COMPACTION_RETAIN_MESSAGES must be set together.",
      name: "missing retain threshold",
    },
    {
      env: { PSS_AUTO_COMPACTION_RETAIN_MESSAGES: "4" },
      message:
        "PSS_AUTO_COMPACTION_MIN_MESSAGES and PSS_AUTO_COMPACTION_RETAIN_MESSAGES must be set together.",
      name: "missing minimum threshold",
    },
    {
      env: {
        PSS_AUTO_COMPACTION_MIN_MESSAGES: "12.5",
        PSS_AUTO_COMPACTION_RETAIN_MESSAGES: "4",
      },
      message: "PSS_AUTO_COMPACTION_MIN_MESSAGES must be a positive integer.",
      name: "fractional minimum threshold",
    },
    {
      env: {
        PSS_AUTO_COMPACTION_MIN_MESSAGES: "12",
        PSS_AUTO_COMPACTION_RETAIN_MESSAGES: "0",
      },
      message:
        "PSS_AUTO_COMPACTION_RETAIN_MESSAGES must be a positive integer.",
      name: "zero retain threshold",
    },
    {
      env: {
        PSS_AUTO_COMPACTION_MIN_MESSAGES: "4",
        PSS_AUTO_COMPACTION_RETAIN_MESSAGES: "4",
      },
      message:
        "PSS_AUTO_COMPACTION_RETAIN_MESSAGES must be smaller than PSS_AUTO_COMPACTION_MIN_MESSAGES.",
      name: "retain threshold equals minimum threshold",
    },
  ] as const)("rejects malformed auto compaction env: $name", ({
    env,
    message,
  }) => {
    expect(() =>
      resolveCodingAgentThreadConfig(env, "/repo/demo", "/home/me")
    ).toThrow(message);
  });
});
