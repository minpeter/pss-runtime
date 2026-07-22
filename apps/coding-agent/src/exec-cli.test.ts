import { describe, expect, it } from "vitest";
import { formatExecUsage, parseExecArguments } from "./exec-cli";

const choosePromptPattern = /Choose exactly one/u;
const timeoutPattern = /1 to 1200/u;
const unknownOptionPattern = /Unknown pss exec option/u;

describe("headless exec arguments", () => {
  it("parses a pinned benchmark invocation", () => {
    expect(
      parseExecArguments(
        [
          "--workspace",
          "fixture",
          "--stdin",
          "--model",
          "qwen3.8-max-preview",
          "--base-url",
          "https://gateway.example/v1",
          "--timeout-seconds",
          "900",
          "--web-tools",
          "disabled",
          "--result-file",
          "/tmp/result.json",
        ],
        "/repo"
      )
    ).toStrictEqual({
      baseUrl: "https://gateway.example/v1",
      help: false,
      model: "qwen3.8-max-preview",
      readStdin: true,
      resultFile: "/tmp/result.json",
      timeoutSeconds: 900,
      webToolsAvailability: "disabled",
      workspace: "/repo/fixture",
    });
  });

  it("requires exactly one prompt source", () => {
    expect(() => parseExecArguments([], "/repo")).toThrow(choosePromptPattern);
    expect(() =>
      parseExecArguments(["--prompt", "one", "--stdin"], "/repo")
    ).toThrow(choosePromptPattern);
  });

  it("rejects unknown options and invalid timeouts", () => {
    expect(() =>
      parseExecArguments(["--prompt", "one", "--wat"], "/repo")
    ).toThrow(unknownOptionPattern);
    expect(() =>
      parseExecArguments(
        ["--prompt", "one", "--timeout-seconds", "1201"],
        "/repo"
      )
    ).toThrow(timeoutPattern);
  });

  it("allows help without a prompt", () => {
    expect(parseExecArguments(["--help"], "/repo").help).toBe(true);
    expect(formatExecUsage()).toContain("pss exec --workspace");
  });
});
