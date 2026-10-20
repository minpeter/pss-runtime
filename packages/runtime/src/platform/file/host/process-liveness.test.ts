import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { createProcessOwnerLiveness } from "./process-liveness";

describe("file host lease owner liveness", () => {
  it("proves an owner with this process's identity gone once its process exited", async () => {
    // Given: a process that ran on this host, boot, and PID namespace and exited.
    const pid = await exitedPid();
    const liveness = createProcessOwnerLiveness();

    // When / Then: its leases are abandoned.
    expect(liveness.isGone({ ...ownerWithPid(pid), id: "exited" })).toBe(true);
  });

  it.each([
    ["another boot", { bootId: "another-boot" }],
    ["another PID namespace", { pidNamespace: "pid:[1]" }],
    ["another host", { hostname: `not-${hostname()}` }],
  ])("never proves an exited owner from %s gone", async (_where, differs) => {
    // Given: an exited pid recorded by a process elsewhere that shares the rest.
    const pid = await exitedPid();
    const liveness = createProcessOwnerLiveness();

    // When / Then: the pid may belong to a live process there.
    expect(
      liveness.isGone({ ...ownerWithPid(pid), ...differs, id: "elsewhere" })
    ).toBe(false);
  });

  it
    .runIf(
      liveness().self?.bootId !== undefined &&
        liveness().self?.pidNamespace !== undefined
    )
    .each(["bootId", "pidNamespace"] as const)(
    "never proves an exited owner without a %s gone",
    async (fact) => {
      const liveness = createProcessOwnerLiveness();
      // Given: an exited pid on this host recorded without a fact this process has.
      const { [fact]: _omitted, ...owner } = ownerWithPid(await exitedPid());

      // When / Then: nothing proves the pid is from this PID space.
      expect(liveness.isGone({ ...owner, id: "older-runtime" })).toBe(false);
    }
  );

  it.each([
    ["a live process on this host", process.ppid],
    ["an owner without a pid", undefined],
  ])("never proves %s gone", (_owner, pid) => {
    const liveness = createProcessOwnerLiveness();

    expect(liveness.isGone({ ...ownerWithPid(pid), id: "other-process" })).toBe(
      false
    );
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

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) {
    throw new Error("Expected the child process to have a pid.");
  }
  return child.pid;
}

/** The identity this process records, for the process with `pid`. */
function ownerWithPid(pid: number | undefined) {
  const { pid: _pid, processStart: _start, ...self } = liveness().self ?? {};
  return { ...self, ...(pid === undefined ? {} : { pid }) };
}
