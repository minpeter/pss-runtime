import { describe, expect, it } from "vitest";
import { resolveCodingAgentThreadConfig } from "./thread-config";

describe("resolveCodingAgentThreadConfig", () => {
  it("defaults to a durable home directory and cwd-scoped key", () => {
    expect(
      resolveCodingAgentThreadConfig({}, "/repo/demo", "/home/me")
    ).toEqual({
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
      directory: "/home/me/.pss/threads",
      key: "cwd:/repo/demo",
    });
  });
});
