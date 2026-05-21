import { describe, expect, it } from "vitest";
import { resolveCodingAgentSessionConfig } from "./session-config";

describe("resolveCodingAgentSessionConfig", () => {
  it("defaults to a durable home directory and cwd-scoped key", () => {
    expect(
      resolveCodingAgentSessionConfig({}, "/repo/demo", "/home/me")
    ).toEqual({
      directory: "/home/me/.pss/sessions",
      key: "cwd:/repo/demo",
    });
  });

  it("allows callers to override the file directory and session key", () => {
    expect(
      resolveCodingAgentSessionConfig(
        {
          PSS_SESSION_DIR: ".pss/sessions",
          PSS_SESSION_KEY: "workspace:demo",
        },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      directory: ".pss/sessions",
      key: "workspace:demo",
    });
  });

  it("treats blank env overrides as absent", () => {
    expect(
      resolveCodingAgentSessionConfig(
        { PSS_SESSION_DIR: " ", PSS_SESSION_KEY: "" },
        "/repo/demo",
        "/home/me"
      )
    ).toEqual({
      directory: "/home/me/.pss/sessions",
      key: "cwd:/repo/demo",
    });
  });
});
