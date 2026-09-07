import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodingAgentCli } from "./cli";
import { startTui } from "./tui/app";
import { PENDING_SPINNER_INTERVAL_MS } from "./tui/pending-spinner";

vi.mock("./tui/app", () => ({ startTui: vi.fn(async () => 0) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CLI startup wiring", () => {
  it("forwards the selected workspace to the TUI entry point", async () => {
    const cwd = "/selected/workspace";
    const stdout = { write: vi.fn() };
    await runCodingAgentCli({
      argv: [],
      cwd,
      loadExtensions: async () => ({ extensions: [], notices: [] }),
      stdout,
    });
    expect(startTui).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, startupOutput: stdout })
    );
  });

  it.each([true, false, undefined])(
    "uses the supplied stream's TTY capability (%s), not the process terminal",
    async (isTTY) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      const processWrite = vi
        .spyOn(process.stdout, "write")
        .mockReturnValue(true);
      const stdout = {
        columns: 2,
        ...(isTTY === undefined ? {} : { isTTY }),
        write: vi.fn(),
      };
      try {
        await runCodingAgentCli({
          argv: [],
          loadExtensions: () => {
            const before = stdout.write.mock.calls.length;
            vi.advanceTimersByTime(PENDING_SPINNER_INTERVAL_MS);
            expect(stdout.write.mock.calls.length - before).toBe(isTTY ? 1 : 0);
            return Promise.resolve({ extensions: [], notices: [] });
          },
          start: async () => 0,
          stdout,
        });
        expect(processWrite).not.toHaveBeenCalled();
        expect(stdout.write.mock.calls.length > 0).toBe(isTTY === true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        if (tty) {
          Object.defineProperty(process.stdout, "isTTY", tty);
        } else {
          Reflect.deleteProperty(process.stdout, "isTTY");
        }
      }
    }
  );
});
