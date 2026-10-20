import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { createProcessOwnerLiveness } from "./process-liveness";

describe("file host lease owner liveness", () => {
  it("proves an owner on this host gone once its process exited", async () => {
    // Given: a process that ran on this host and exited.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    const liveness = createProcessOwnerLiveness();

    // When / Then: its leases are abandoned.
    expect(
      liveness.isGone({ hostname: hostname(), id: "exited", pid: child.pid })
    ).toBe(true);
  });

  it.each([
    [
      "a live process on this host",
      { hostname: hostname(), pid: process.ppid },
    ],
    ["a process on another host", { hostname: `not-${hostname()}`, pid: 1 }],
    ["an owner without a pid", { hostname: hostname() }],
  ])("never proves %s gone", (_owner, facts) => {
    const liveness = createProcessOwnerLiveness();

    expect(liveness.isGone({ ...facts, id: "other-process" })).toBe(false);
  });

  it("keeps an owner alive that shares this process but not its runtime", () => {
    // Given: a lease taken in this process by another runtime instance.
    const liveness = createProcessOwnerLiveness();

    // When / Then: the process is the same, so the owner is not gone.
    expect(liveness.isGone({ ...liveness.self, id: "other-runtime" })).toBe(
      false
    );
  });

  it.runIf(liveness().self?.processStart !== undefined)(
    "proves an earlier process gone once a new one reuses its pid",
    () => {
      // Given: a lease recorded with this pid but another start time.
      const self = liveness().self;

      // When / Then: the pid now belongs to a different process.
      expect(
        liveness().isGone({ ...self, id: "earlier", processStart: "0" })
      ).toBe(true);
    }
  );
});

function liveness() {
  return createProcessOwnerLiveness();
}
