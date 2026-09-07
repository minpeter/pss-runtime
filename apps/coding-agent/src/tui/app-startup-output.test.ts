import { afterEach, expect, it, vi } from "vitest";
import { startTui } from "./app";

// Observe the real pre-mount renderer without constructing a terminal session.
// Extension initialization rejects after the startup status has acquired its row.
vi.mock("../extensions/defaults", () => ({
  createCodingAgentExtensionHostWithDefaults: () => Promise.reject(failure),
}));
const { failure } = vi.hoisted(() => ({ failure: new Error("fixture") }));

afterEach(() => vi.restoreAllMocks());

it("clears the supplied startup stream when TUI initialization rejects", async () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  const processWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const startupOutput = { columns: 2, isTTY: true, write: vi.fn() };
  const options = { startupOutput, tools: {} };
  try {
    await expect(startTui(options)).rejects.toBe(failure);
    expect(processWrite).not.toHaveBeenCalled();
    expect(startupOutput.write).toHaveBeenCalledTimes(2);
    expect(startupOutput.write).toHaveBeenLastCalledWith("\r\x1b[2K");
  } finally {
    if (tty) {
      Object.defineProperty(process.stdout, "isTTY", tty);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
});
